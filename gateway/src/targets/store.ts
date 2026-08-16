/**
 * The target store: the one module in `targets/` that performs I/O.
 *
 * The design doc's dependency rule keeps `routing/`, `targets/`, and `providers/` pure so
 * the data path stays portable. This file is the single deliberate concession
 * (docs/design-docs/gateway-design.md): every mention of `node:sqlite`, of SQL, and of the
 * on-disk shape lives here, so a Rust or Go data plane replaces one file rather than a
 * package. Nothing else in `targets/` may import `node:sqlite`.
 *
 * The store is SQLite in WAL mode, designed from the first milestone for concurrent
 * writer processes rather than a single writer
 * (docs/adr/0002-durable-target-store-with-cross-process-concurrency.md). There is no
 * in-process mutex anywhere below, and no assumption that this process is the only one
 * holding the file open: optimistic concurrency is enforced by the store's transactional
 * compare-and-set. That one primitive covers two problems — the `409` on the target
 * document, and de-duplicating `unmet` notifications across processes.
 *
 * The notification signing secret is deliberately absent. It is a credential with a
 * different lifecycle, and keeping it out means no backup, dump, or document read path
 * here is a secret-handling path.
 */

import { DatabaseSync } from "node:sqlite";

import { randomBytes } from "node:crypto";

import type { ReservationDocument, TargetDocument, UnmetState, WindowSummary } from "../types.js";
import { parseTargetDocument, serializeTargetDocument } from "./document.js";
import {
  parseReservationDocument,
  serializeReservationDocument,
} from "../reservations/document.js";

/**
 * The customer a store opened without being told one is scoped to.
 *
 * The column used to carry this value and nothing else. Now that a connector token resolves
 * to a real customer, the value is only a default: it keeps every caller that predates
 * authentication — the target service, the management API — reading and writing exactly the
 * rows they always did, so gaining a second customer changed no existing call site.
 */
export const DEFAULT_CUSTOMER_ID = "default";

/**
 * How long a minted connector token is, in bytes of `node:crypto` randomness.
 *
 * 32 bytes because the token is a bearer credential with no expiry and no second factor:
 * it is the whole proof of identity, so it must be infeasible to guess rather than merely
 * inconvenient. Hex rather than base64url so the token survives being pasted into a URL,
 * an env file, or a shell without quoting.
 */
const TOKEN_BYTES = 32;

/**
 * How long a writer waits for another process's write lock before giving up.
 *
 * Without this, a concurrent `BEGIN IMMEDIATE` fails instantly with SQLITE_BUSY, which
 * would turn ordinary cross-process contention into a spurious error. Waiting is correct
 * because every transaction here is short and bounded.
 */
const BUSY_TIMEOUT_MS = 5_000;

/**
 * The store could not be opened, read, or written.
 *
 * A distinguishable type rather than a generic throw because the caller's response to it
 * is specific: boot anyway, serve the data path as pure passthrough, and fail management
 * reads and writes with `503`. Refusing to boot was considered and rejected — a corrupt
 * control-plane file must not stop customer traffic from reaching a provider.
 */
export class StoreUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StoreUnavailableError";
  }
}

/**
 * The outcome of a compare-and-set write.
 *
 * `version` is the store's current version either way: the new one when the write won, and
 * the one the caller lost to when it did not. Returning the current version on failure is
 * what lets the caller's `409` tell the client what to re-read, rather than making them
 * ask again.
 */
export interface WriteResult {
  readonly ok: boolean;
  readonly version: number;
}

/** Row shapes as they come back from SQLite. Confined to this file with the SQL. */
interface DocumentRow {
  readonly version: number;
  readonly document: string;
}

interface VersionRow {
  readonly version: number;
}

interface SummaryRow {
  readonly workload: string;
  readonly provider_id: string;
  readonly process_id: string;
  readonly opened_at_ms: number;
  readonly closed_at_ms: number;
  readonly latencies_ms: string;
  readonly success_count: number;
  readonly request_count: number;
  readonly cost_per_1k_tokens_usd_sum: number;
}

interface UnmetRow {
  readonly state: string;
}

interface ConnectorRow {
  readonly customer_id: string;
}

interface DirectiveRow {
  readonly workload: string;
  readonly pushed_version: number;
  readonly pushed_at_ms: number;
  readonly acked_version: number | null;
  readonly acked_at_ms: number | null;
  readonly delivery_mode: string;
}

interface UsageRow {
  readonly workload: string;
  readonly provider_id: string;
  readonly model: string;
  readonly region: string;
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly latency_ms: number;
  readonly status_code: number;
  readonly rate_limit_limit: string | null;
  readonly rate_limit_reset: string | null;
  readonly reservation_id: string | null;
  readonly at_ms: number;
}

interface UsageTotalsRow {
  readonly workload: string;
  readonly request_count: number;
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
}

/**
 * How a connector came by the list version it is on.
 *
 * Not a label: it is the diagnosis. A connector on `"poll"` is one the push channel could
 * not reach, and the gateway can only tell the two apart by how long the acknowledgement
 * took, which is why both the delivery instant and the ack instant are stored.
 */
export type DeliveryMode = "push" | "poll";

/**
 * What the gateway knows about one connector's adoption of one workload's list.
 *
 * The acknowledgement is the only proof a list was actually adopted; a version the gateway
 * computed and sent is a version it *hopes* is in force. `ackedVersion` is kept separate
 * from `pushedVersion` so a connector sitting on a stale list is visible as a mismatch
 * rather than disappearing behind the newest push.
 */
export interface ConnectorDirective {
  readonly workload: string;
  readonly pushedVersion: number;
  readonly pushedAtMs: number;
  readonly ackedVersion: number | null;
  readonly ackedAtMs: number | null;
  readonly deliveryMode: DeliveryMode;
}

/** A minted connector credential, as the admin endpoint reports it back exactly once. */
export interface ConnectorRecord {
  readonly token: string;
  readonly customerId: string;
  readonly createdAtMs: number;
}

/**
 * One provider call a connector made, as reported after the fact.
 *
 * Mirrors the wire contract's `UsageRecord` field for field. These rows are the only
 * evidence the gateway has of traffic it never saw: the connector calls providers directly,
 * so without this the status resource could report decisions but never their consequences.
 */
export interface ConnectorUsageRecord {
  readonly workload: string;
  readonly providerId: string;
  readonly model: string;
  readonly region: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly latencyMs: number;
  readonly statusCode: number;
  readonly rateLimitLimit: string | null;
  readonly rateLimitReset: string | null;
  readonly reservationId: string | null;
  readonly atMs: number;
}

/** Token counts rolled up per workload, which is the grain the status resource reports. */
export interface WorkloadUsageTotals {
  readonly workload: string;
  readonly requestCount: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/**
 * How long a connector took to adopt the version it was last offered, or `null`.
 *
 * `null` when nothing has been acknowledged, and when the acknowledgement is for an older
 * version than the one outstanding — in both cases the connector has not adopted what it
 * was last sent, and reporting a delay for a superseded version would read as agreement.
 */
export function ackDelayMs(directive: ConnectorDirective): number | null {
  if (directive.ackedVersion !== directive.pushedVersion) return null;
  if (directive.ackedAtMs === null) return null;
  return directive.ackedAtMs - directive.pushedAtMs;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS target_document (
  customer_id   TEXT    NOT NULL DEFAULT 'default',
  version       INTEGER NOT NULL,
  document      TEXT    NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (customer_id)
);

-- Its own table, not a column on target_document, for the reason in the Decision Log: a
-- reservation's term expiring would otherwise change what a target means with no customer
-- write. Same envelope (customer, version, document) because it gets the same optimistic
-- concurrency; different row because it is a different statement.
CREATE TABLE IF NOT EXISTS reservation_document (
  customer_id   TEXT    NOT NULL DEFAULT 'default',
  version       INTEGER NOT NULL,
  document      TEXT    NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (customer_id)
);

CREATE TABLE IF NOT EXISTS decision_receipt (
  customer_id   TEXT    NOT NULL DEFAULT 'default',
  version       INTEGER NOT NULL,
  receipt       TEXT    NOT NULL,
  written_at_ms INTEGER NOT NULL,
  PRIMARY KEY (customer_id, version)
);

CREATE TABLE IF NOT EXISTS window_summary (
  customer_id                TEXT    NOT NULL DEFAULT 'default',
  workload                   TEXT    NOT NULL,
  provider_id                TEXT    NOT NULL,
  process_id                 TEXT    NOT NULL,
  opened_at_ms               INTEGER NOT NULL,
  closed_at_ms               INTEGER NOT NULL,
  latencies_ms               TEXT    NOT NULL,
  success_count              INTEGER NOT NULL,
  request_count              INTEGER NOT NULL,
  cost_per_1k_tokens_usd_sum REAL    NOT NULL,
  PRIMARY KEY (customer_id, workload, provider_id, process_id, closed_at_ms)
);

CREATE INDEX IF NOT EXISTS window_summary_by_close
  ON window_summary (customer_id, workload, closed_at_ms);

CREATE TABLE IF NOT EXISTS unmet_state (
  customer_id   TEXT    NOT NULL DEFAULT 'default',
  workload      TEXT    NOT NULL,
  state         TEXT    NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (customer_id, workload)
);

CREATE TABLE IF NOT EXISTS connectors (
  token         TEXT    NOT NULL,
  customer_id   TEXT    NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (token)
);

CREATE INDEX IF NOT EXISTS connectors_by_customer
  ON connectors (customer_id);

CREATE TABLE IF NOT EXISTS connector_directive (
  customer_id    TEXT    NOT NULL DEFAULT 'default',
  workload       TEXT    NOT NULL,
  pushed_version INTEGER NOT NULL,
  pushed_at_ms   INTEGER NOT NULL,
  acked_version  INTEGER,
  acked_at_ms    INTEGER,
  delivery_mode  TEXT    NOT NULL,
  PRIMARY KEY (customer_id, workload)
);

CREATE TABLE IF NOT EXISTS connector_usage (
  customer_id       TEXT    NOT NULL DEFAULT 'default',
  workload          TEXT    NOT NULL,
  provider_id       TEXT    NOT NULL,
  model             TEXT    NOT NULL,
  region            TEXT    NOT NULL,
  prompt_tokens     INTEGER NOT NULL,
  completion_tokens INTEGER NOT NULL,
  latency_ms        INTEGER NOT NULL,
  status_code       INTEGER NOT NULL,
  rate_limit_limit  TEXT,
  rate_limit_reset  TEXT,
  reservation_id    TEXT,
  at_ms             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS connector_usage_by_time
  ON connector_usage (customer_id, at_ms);
`;

/**
 * Serialize an `UnmetState` with a fixed field order.
 *
 * `casUnmetState` compares the caller's `expected` against what is stored, and the
 * comparison has to survive a round trip through the database. `JSON.stringify` alone does
 * not: it preserves insertion order, so a state the caller rebuilt by hand would compare
 * unequal to the identical state read back. Naming every field here makes the encoding the
 * single definition of "the same state", and makes the stored text stable across writers.
 */
function encodeUnmetState(state: UnmetState): string {
  return JSON.stringify({
    workload: state.workload,
    unmet: state.unmet,
    since: state.since,
    missedStreak: state.missedStreak,
    heldStreak: state.heldStreak,
    lastWindowAtMs: state.lastWindowAtMs,
    report:
      state.report === null
        ? null
        : {
            dimension: state.report.dimension,
            target: state.report.target,
            observed: state.report.observed,
            windowSpanMs: state.report.windowSpanMs,
            windowRequestCount: state.report.windowRequestCount,
            rejections: state.report.rejections.map((rejection) => ({
              providerId: rejection.providerId,
              dimension: rejection.dimension,
              observed: rejection.observed,
              target: rejection.target,
              reason: rejection.reason,
            })),
          },
  });
}

function decodeUnmetState(encoded: string): UnmetState {
  return JSON.parse(encoded) as UnmetState;
}

/**
 * Values SQLite will accept as a bound parameter here.
 *
 * `null` is in the set because the connector tables have genuinely absent fields — a
 * provider that returned no rate-limit header, a call against no reservation — and
 * encoding those as an empty string would make "absent" and "empty" the same row.
 */
type SqlValue = string | number | null;

/** Named parameters, always excluding `customer`, which the helpers bind themselves. */
type SqlParams = Readonly<Record<string, SqlValue>>;

export class TargetStore {
  readonly #db: DatabaseSync;
  readonly #customerId: string;
  /** Only the opener closes the handle; a `forCustomer` view borrows it. */
  readonly #ownsDb: boolean;
  #closed = false;

  private constructor(db: DatabaseSync, customerId: string, ownsDb: boolean) {
    this.#db = db;
    this.#customerId = customerId;
    this.#ownsDb = ownsDb;
  }

  /** The customer every query on this instance is scoped to. */
  get customerId(): string {
    return this.#customerId;
  }

  /**
   * The same database, seen as a different customer.
   *
   * Scoping is a property of the handle rather than an argument to each method, and this is
   * why: a method that took a `customerId` could be called without one, or with the wrong
   * one, at any of the dozens of call sites. Here there is no query you can write that omits
   * the customer — `#run`/`#get`/`#all` bind `$customer` on every statement, and `node:sqlite`
   * rejects a named parameter the SQL does not mention, so a query that forgets the scope
   * fails the first time it runs rather than quietly returning another customer's rows.
   * The one deliberate exception is `resolveConnectorCustomer`, which cannot be scoped
   * because it is the thing that produces the scope; it is marked as such below.
   */
  forCustomer(customerId: string): TargetStore {
    if (customerId === this.#customerId) return this;
    return new TargetStore(this.#db, customerId, false);
  }

  /**
   * Open (creating if absent) the store at `path`.
   *
   * Everything that can go wrong with the file surfaces as `StoreUnavailableError`: a
   * missing parent directory, a path that is not a database, a corrupt header. SQLite is
   * lazy about validating a file, so the probe below forces a real read rather than
   * trusting that construction succeeding means the file is usable.
   */
  static open(path: string, customerId: string = DEFAULT_CUSTOMER_ID): TargetStore {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(path);
    } catch (cause) {
      throw new StoreUnavailableError(`cannot open target store at ${path}`, { cause });
    }

    try {
      // WAL is not a performance tweak here: it is what gives readers a consistent view
      // while another process holds the write lock, which is the whole cross-process
      // premise. `busy_timeout` makes contention a wait rather than an error.
      db.exec(`PRAGMA journal_mode = WAL;`);
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
      db.exec(`PRAGMA foreign_keys = ON;`);
      db.exec(SCHEMA);
      // Forces a page read even when every statement above was satisfied from cache.
      db.prepare(`SELECT count(*) AS n FROM target_document`).get();
    } catch (cause) {
      try {
        db.close();
      } catch {
        // Already unusable; the original failure is the one worth reporting.
      }
      throw new StoreUnavailableError(`target store at ${path} is not readable`, { cause });
    }

    return new TargetStore(db, customerId, true);
  }

  /**
   * The stored document, or `null` when no customer write has landed yet.
   *
   * `null` means "nobody has stated a target", which is a legitimate steady state. It is
   * emphatically not what an unreadable store returns — that throws — because a corruption
   * that presented as an empty document would look like deliberate configuration, and the
   * customer would never learn their targets had stopped being applied.
   */
  readDocument(): TargetDocument | null {
    const row = this.#get<DocumentRow>(
      `SELECT version, document FROM target_document WHERE customer_id = $customer`,
    );
    if (row === undefined) return null;

    try {
      return parseTargetDocument(JSON.parse(row.document), row.version);
    } catch (cause) {
      // A row that will not parse is corruption of the same kind as an unreadable file:
      // the caller must degrade, not treat it as "no targets stated".
      throw new StoreUnavailableError("the stored target document could not be parsed", {
        cause,
      });
    }
  }

  /** The current document version, or `0` when nothing has been written. */
  readVersion(): number {
    return this.#readVersion();
  }

  /**
   * Replace the document, but only if `expectedVersion` is still current.
   *
   * The compare and the write are one `BEGIN IMMEDIATE` transaction, which takes the
   * write lock before reading. That is what makes the check meaningful across processes:
   * with a deferred transaction two writers could both read version 3 and both believe
   * they won. On success the version is `expectedVersion + 1` and the data is durable
   * before this returns — `PUT` acking a version the store has not committed would make
   * "single source of truth" untrue.
   *
   * A `receipt`, when given, is committed in the *same* transaction, in a sibling table
   * keyed by document version. Same transaction because a committed document without its
   * receipt is a decision we cannot audit later; a sibling table because the document is
   * the customer's own statement of intent and must not carry fields they did not author.
   */
  writeDocument(
    expectedVersion: number,
    doc: TargetDocument,
    receipt: unknown | null,
  ): WriteResult {
    const document = JSON.stringify(serializeTargetDocument(doc));
    const now = Date.now();

    return this.#transact(() => {
      const current = this.#readVersion();
      if (current !== expectedVersion) {
        // The loser learns the version it lost to, and nothing is mutated. The gateway
        // never retries on the client's behalf: `409` is terminal, the client re-reads and
        // re-decides, and that is what makes livelock impossible.
        return { ok: false, version: current };
      }

      const version = expectedVersion + 1;
      this.#run(
        `INSERT INTO target_document (customer_id, version, document, updated_at_ms)
         VALUES ($customer, $version, $document, $now)
         ON CONFLICT (customer_id) DO UPDATE SET
           version = excluded.version,
           document = excluded.document,
           updated_at_ms = excluded.updated_at_ms`,
        { version, document, now },
      );

      if (receipt !== null) {
        this.#run(
          `INSERT INTO decision_receipt (customer_id, version, receipt, written_at_ms)
           VALUES ($customer, $version, $receipt, $now)
           ON CONFLICT (customer_id, version) DO UPDATE SET
             receipt = excluded.receipt,
             written_at_ms = excluded.written_at_ms`,
          { version, receipt: JSON.stringify(receipt), now },
        );
      }

      // A receipt records the floors one accepted write was decided against. Once a newer
      // version supersedes it there is no decision left to audit, so it is pruned here
      // rather than accumulating a row per write forever.
      this.#run(
        `DELETE FROM decision_receipt WHERE customer_id = $customer AND version < $version`,
        { version },
      );

      return { ok: true, version };
    });
  }

  // -------------------------------------------------------------------------
  // Reservations: what the customer has already paid a provider for.
  // -------------------------------------------------------------------------

  /** The stored reservation document, or `null` when no customer write has landed yet. */
  readReservations(): ReservationDocument | null {
    const row = this.#get<DocumentRow>(
      `SELECT version, document FROM reservation_document WHERE customer_id = $customer`,
    );
    if (row === undefined) return null;

    try {
      return parseReservationDocument(JSON.parse(row.document), row.version);
    } catch (cause) {
      // Same reasoning as `readDocument`: a row that will not parse is corruption, and
      // presenting it as "no reservations declared" would silently stop routing traffic onto
      // capacity the customer is still being billed for.
      throw new StoreUnavailableError("the stored reservation document could not be parsed", {
        cause,
      });
    }
  }

  /** The current reservation document version, or `0` when nothing has been written. */
  readReservationVersion(): number {
    return this.#readReservationVersion();
  }

  /**
   * Replace the reservation document, but only if `expectedVersion` is still current.
   *
   * The same `BEGIN IMMEDIATE` compare-and-set as `writeDocument`, deliberately duplicated
   * rather than generalized over a table name: the two documents are versioned
   * independently, and a shared helper parameterized by table is one refactor away from a
   * shared *version*, which would make a reservation write bump the target document the
   * customer never touched.
   */
  writeReservations(expectedVersion: number, doc: ReservationDocument): WriteResult {
    const document = JSON.stringify(serializeReservationDocument(doc));
    const now = Date.now();

    return this.#transact(() => {
      const current = this.#readReservationVersion();
      if (current !== expectedVersion) {
        return { ok: false, version: current };
      }

      const version = expectedVersion + 1;
      this.#run(
        `INSERT INTO reservation_document (customer_id, version, document, updated_at_ms)
         VALUES ($customer, $version, $document, $now)
         ON CONFLICT (customer_id) DO UPDATE SET
           version = excluded.version,
           document = excluded.document,
           updated_at_ms = excluded.updated_at_ms`,
        { version, document, now },
      );

      return { ok: true, version };
    });
  }

  /**
   * Persist one process's view of one closed window.
   *
   * Best-effort by design: raw samples are derived and cheap to rebuild from traffic, and
   * persisting a hot rolling window would put the store on the request path. Summaries
   * exist only so several processes can be merged. The primary key includes `process_id`
   * so two processes closing the same window never overwrite each other — the merge is the
   * point.
   */
  writeWindowSummary(summary: WindowSummary): void {
    this.#run(
      `INSERT INTO window_summary (
         customer_id, workload, provider_id, process_id, opened_at_ms, closed_at_ms,
         latencies_ms, success_count, request_count, cost_per_1k_tokens_usd_sum
       ) VALUES ($customer, $workload, $providerId, $processId, $openedAtMs, $closedAtMs,
                $latenciesMs, $successCount, $requestCount, $costSum)
       ON CONFLICT (customer_id, workload, provider_id, process_id, closed_at_ms)
       DO UPDATE SET
         opened_at_ms = excluded.opened_at_ms,
         latencies_ms = excluded.latencies_ms,
         success_count = excluded.success_count,
         request_count = excluded.request_count,
         cost_per_1k_tokens_usd_sum = excluded.cost_per_1k_tokens_usd_sum`,
      {
        workload: summary.workload,
        providerId: summary.providerId,
        processId: summary.processId,
        openedAtMs: summary.openedAtMs,
        closedAtMs: summary.closedAtMs,
        latenciesMs: JSON.stringify(summary.latenciesMs),
        successCount: summary.successCount,
        requestCount: summary.requestCount,
        costSum: summary.costPer1kTokensUsdSum,
      },
    );
  }

  /**
   * Every process's summaries for `workload` that closed at or after `closedSinceMs`.
   *
   * Deliberately not filtered by process: the `unmet` machine evaluates over merged
   * summaries, which is why the sample floor is workload-wide rather than per-process. A
   * reader who assumes per-process will misread a scale-down as a regression when the
   * merged count drops below the floor and the workload reports `insufficient_data`.
   */
  readWindowSummaries(workload: string, closedSinceMs: number): WindowSummary[] {
    const rows = this.#all<SummaryRow>(
      `SELECT workload, provider_id, process_id, opened_at_ms, closed_at_ms,
              latencies_ms, success_count, request_count, cost_per_1k_tokens_usd_sum
         FROM window_summary
        WHERE customer_id = $customer AND workload = $workload AND closed_at_ms >= $since
        ORDER BY closed_at_ms ASC, provider_id ASC, process_id ASC`,
      { workload, since: closedSinceMs },
    );

    return rows.map((row) => ({
      workload: row.workload,
      providerId: row.provider_id,
      processId: row.process_id,
      openedAtMs: row.opened_at_ms,
      closedAtMs: row.closed_at_ms,
      latenciesMs: JSON.parse(row.latencies_ms) as number[],
      successCount: row.success_count,
      requestCount: row.request_count,
      costPer1kTokensUsdSum: row.cost_per_1k_tokens_usd_sum,
    }));
  }

  /**
   * Drop summaries that closed before `closedBeforeMs`, across all workloads.
   *
   * This is the whole liveness story: a crashed or scaled-down process's rows age out by
   * timestamp within one window. No heartbeat, no leader election, and nothing that has to
   * notice a process is gone — the absence of new rows is the signal.
   */
  pruneWindowSummaries(closedBeforeMs: number): void {
    this.#run(
      `DELETE FROM window_summary WHERE customer_id = $customer AND closed_at_ms < $before`,
      { before: closedBeforeMs },
    );
  }

  /** The persisted `unmet` state for a workload, or `null` when none was ever written. */
  readUnmetState(workload: string): UnmetState | null {
    const row = this.#get<UnmetRow>(
      `SELECT state FROM unmet_state WHERE customer_id = $customer AND workload = $workload`,
      { workload },
    );
    if (row === undefined) return null;

    try {
      return decodeUnmetState(row.state);
    } catch (cause) {
      throw new StoreUnavailableError(
        `the stored unmet state for workload ${workload} could not be parsed`,
        { cause },
      );
    }
  }

  /**
   * Move the workload's `unmet` state from `expected` to `next`, if it is still `expected`.
   *
   * This is the same primitive as the document's `409`, used for a different problem: the
   * process that wins the CAS is the one that sends the notification, and the processes
   * that lose observe the state move and stay silent. Without it, N processes fire N
   * notifications for one transition, which reads to a customer as a flapping target — the
   * very thing the symmetric two-window rule exists to prevent.
   *
   * `expected` of `null` means "no state has ever been written", so the first process to
   * record a transition wins and the rest see the row and fail.
   */
  casUnmetState(workload: string, expected: UnmetState | null, next: UnmetState): boolean {
    const now = Date.now();

    return this.#transact(() => {
      const row = this.#get<UnmetRow>(
        `SELECT state FROM unmet_state WHERE customer_id = $customer AND workload = $workload`,
        { workload },
      );

      const stored = row === undefined ? null : row.state;
      const wanted = expected === null ? null : encodeUnmetState(expected);
      if (stored !== wanted) return false;

      this.#run(
        `INSERT INTO unmet_state (customer_id, workload, state, updated_at_ms)
         VALUES ($customer, $workload, $state, $now)
         ON CONFLICT (customer_id, workload) DO UPDATE SET
           state = excluded.state,
           updated_at_ms = excluded.updated_at_ms`,
        { workload, state: encodeUnmetState(next), now },
      );

      return true;
    });
  }

  // -------------------------------------------------------------------------
  // Connector credentials. The token is the connector's whole identity: it is
  // what turns an anonymous request into a customer-scoped one.
  // -------------------------------------------------------------------------

  /**
   * Mint a fresh connector token for this instance's customer.
   *
   * Every call produces a new token rather than returning an existing one. That is
   * deliberate: two connectors for one customer is normal — a rollout runs old and new side
   * by side — and revocation is per token, so a shared token would make revoking one
   * connector revoke them all. The token is returned once and only stored, never re-read.
   */
  mintConnector(now: number = Date.now()): ConnectorRecord {
    const token = randomBytes(TOKEN_BYTES).toString("hex");
    this.#run(
      `INSERT INTO connectors (token, customer_id, created_at_ms)
       VALUES ($token, $customer, $now)`,
      { token, now },
    );
    return { token, customerId: this.#customerId, createdAtMs: now };
  }

  /**
   * The customer a token belongs to, or `null` when the token is unknown.
   *
   * The single query in this file that is *not* scoped by customer, because it is what
   * produces the scope — scoping it would require already knowing the answer. It reads only
   * the `connectors` table, which is why widening it cannot expose another customer's data:
   * the caller's next move is `forCustomer(resolved)`, and everything after that is scoped
   * again. `null` rather than a throw because an unknown token is an ordinary `401`, not a
   * store failure.
   */
  resolveConnectorCustomer(token: string): string | null {
    let row: ConnectorRow | undefined;
    try {
      row = this.#db
        .prepare(`SELECT customer_id FROM connectors WHERE token = $token`)
        .get({ token }) as ConnectorRow | undefined;
    } catch (cause) {
      throw this.#unavailable("target store read failed", cause);
    }
    return row?.customer_id ?? null;
  }

  /**
   * Revoke a token, reporting whether it was this customer's to revoke.
   *
   * Revocation is deletion: there is no disabled state to reason about, no expiry to sweep,
   * and a deleted row resolves to `null` on the very next request. Scoped by customer so an
   * admin acting for one customer cannot revoke another's connector by guessing a token.
   */
  revokeConnector(token: string): boolean {
    const before = this.#countConnectors();
    this.#run(
      `DELETE FROM connectors WHERE token = $token AND customer_id = $customer`,
      { token },
    );
    return this.#countConnectors() < before;
  }

  /** This customer's live connectors, newest first. Tokens are included; they are stored raw. */
  listConnectors(): ConnectorRecord[] {
    const rows = this.#all<{ token: string; customer_id: string; created_at_ms: number }>(
      `SELECT token, customer_id, created_at_ms
         FROM connectors
        WHERE customer_id = $customer
        ORDER BY created_at_ms DESC, token ASC`,
    );
    return rows.map((row) => ({
      token: row.token,
      customerId: row.customer_id,
      createdAtMs: row.created_at_ms,
    }));
  }

  // -------------------------------------------------------------------------
  // Directives: which list version a connector was offered, and whether it
  // ever said it took the list.
  // -------------------------------------------------------------------------

  /**
   * Record that `version` of `workload`'s list was made available by `mode`.
   *
   * `pushedAtMs` is pinned to the *first* time a version was offered, not the latest offer.
   * That is what makes the ack delay diagnostic: a pushed list is acknowledged within a
   * round trip of becoming available, while a polled one waits out the connector's poll
   * interval, and re-stamping the instant on every re-offer would erase exactly that gap.
   * The delivery mode always takes the latest value, because a connector that fell back to
   * polling is on `"poll"` from that moment regardless of how the version first went out.
   */
  recordDirectiveDelivery(
    workload: string,
    version: number,
    mode: DeliveryMode,
    now: number = Date.now(),
  ): void {
    this.#run(
      `INSERT INTO connector_directive (
         customer_id, workload, pushed_version, pushed_at_ms, acked_version, acked_at_ms,
         delivery_mode
       ) VALUES ($customer, $workload, $version, $now, NULL, NULL, $mode)
       ON CONFLICT (customer_id, workload) DO UPDATE SET
         pushed_version = excluded.pushed_version,
         pushed_at_ms = CASE
           WHEN connector_directive.pushed_version = excluded.pushed_version
             THEN connector_directive.pushed_at_ms
           ELSE excluded.pushed_at_ms
         END,
         delivery_mode = excluded.delivery_mode`,
      { workload, version, mode, now },
    );
  }

  /**
   * Record a connector's acknowledgement, reporting whether the workload was known.
   *
   * `false` when nothing was ever delivered for the workload, which is the `404` the wire
   * contract specifies: acking a list the gateway never sent is a bug in the connector, not
   * a state the gateway should invent a row for. An ack for a superseded version is stored
   * as-is rather than rejected — it is true, and `ackDelayMs` already declines to call it
   * adoption of what is currently outstanding.
   */
  recordDirectiveAck(workload: string, version: number, now: number = Date.now()): boolean {
    return this.#transact(() => {
      const existing = this.#get<DirectiveRow>(
        `SELECT workload, pushed_version, pushed_at_ms, acked_version, acked_at_ms,
                delivery_mode
           FROM connector_directive
          WHERE customer_id = $customer AND workload = $workload`,
        { workload },
      );
      if (existing === undefined) return false;

      this.#run(
        `UPDATE connector_directive
            SET acked_version = $version, acked_at_ms = $now
          WHERE customer_id = $customer AND workload = $workload`,
        { workload, version, now },
      );
      return true;
    });
  }

  /** The directive for one workload, or `null` when no list has been delivered for it. */
  readDirective(workload: string): ConnectorDirective | null {
    const row = this.#get<DirectiveRow>(
      `SELECT workload, pushed_version, pushed_at_ms, acked_version, acked_at_ms, delivery_mode
         FROM connector_directive
        WHERE customer_id = $customer AND workload = $workload`,
      { workload },
    );
    return row === undefined ? null : this.#toDirective(row);
  }

  /** Every workload's directive for this customer, in workload order. */
  readDirectives(): ConnectorDirective[] {
    const rows = this.#all<DirectiveRow>(
      `SELECT workload, pushed_version, pushed_at_ms, acked_version, acked_at_ms, delivery_mode
         FROM connector_directive
        WHERE customer_id = $customer
        ORDER BY workload ASC`,
    );
    return rows.map((row) => this.#toDirective(row));
  }

  // -------------------------------------------------------------------------
  // Usage: the only record of traffic the gateway never saw.
  // -------------------------------------------------------------------------

  /**
   * Append a reported batch of provider calls.
   *
   * One transaction for the batch because a partially stored report is worse than a dropped
   * one: token totals that are silently short read as a traffic drop rather than as a lost
   * report. Append-only with no primary key — a duplicate report costs a duplicated row,
   * whereas a natural key would need a connector-supplied id the wire contract does not
   * carry, and rejecting on it would let a retry look like a failure.
   */
  writeConnectorUsage(records: readonly ConnectorUsageRecord[]): void {
    if (records.length === 0) return;
    this.#transact(() => {
      for (const record of records) {
        this.#run(
          `INSERT INTO connector_usage (
             customer_id, workload, provider_id, model, region, prompt_tokens,
             completion_tokens, latency_ms, status_code, rate_limit_limit, rate_limit_reset,
             reservation_id, at_ms
           ) VALUES (
             $customer, $workload, $providerId, $model, $region, $promptTokens,
             $completionTokens, $latencyMs, $statusCode, $rateLimitLimit, $rateLimitReset,
             $reservationId, $atMs
           )`,
          {
            workload: record.workload,
            providerId: record.providerId,
            model: record.model,
            region: record.region,
            promptTokens: record.promptTokens,
            completionTokens: record.completionTokens,
            latencyMs: record.latencyMs,
            statusCode: record.statusCode,
            rateLimitLimit: record.rateLimitLimit,
            rateLimitReset: record.rateLimitReset,
            reservationId: record.reservationId,
            atMs: record.atMs,
          },
        );
      }
    });
  }

  /** This customer's reported calls at or after `sinceMs`, oldest first. */
  readConnectorUsage(sinceMs: number): ConnectorUsageRecord[] {
    const rows = this.#all<UsageRow>(
      `SELECT workload, provider_id, model, region, prompt_tokens, completion_tokens,
              latency_ms, status_code, rate_limit_limit, rate_limit_reset, reservation_id,
              at_ms
         FROM connector_usage
        WHERE customer_id = $customer AND at_ms >= $since
        ORDER BY at_ms ASC, provider_id ASC`,
      { since: sinceMs },
    );

    return rows.map((row) => ({
      workload: row.workload,
      providerId: row.provider_id,
      model: row.model,
      region: row.region,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
      latencyMs: row.latency_ms,
      statusCode: row.status_code,
      rateLimitLimit: row.rate_limit_limit,
      rateLimitReset: row.rate_limit_reset,
      reservationId: row.reservation_id,
      atMs: row.at_ms,
    }));
  }

  /**
   * Token counts per workload since `sinceMs`.
   *
   * Aggregated in SQL rather than by reading every row and summing: the status resource
   * asks for this on every request, and the row count grows with traffic while the answer
   * stays one row per workload.
   */
  readUsageTotals(sinceMs: number): WorkloadUsageTotals[] {
    const rows = this.#all<UsageTotalsRow>(
      `SELECT workload,
              count(*)                    AS request_count,
              sum(prompt_tokens)          AS prompt_tokens,
              sum(completion_tokens)      AS completion_tokens
         FROM connector_usage
        WHERE customer_id = $customer AND at_ms >= $since
        GROUP BY workload
        ORDER BY workload ASC`,
      { since: sinceMs },
    );

    return rows.map((row) => ({
      workload: row.workload,
      requestCount: row.request_count,
      promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens,
    }));
  }

  /**
   * Drop reported calls older than `beforeMs`.
   *
   * Same aging-out pattern as `pruneWindowSummaries`, for the same reason: this table is
   * evidence for a rolling window, not a ledger, and nothing here should grow without
   * bound just because traffic kept flowing.
   */
  pruneConnectorUsage(beforeMs: number): void {
    this.#run(
      `DELETE FROM connector_usage WHERE customer_id = $customer AND at_ms < $before`,
      { before: beforeMs },
    );
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    // A `forCustomer` view borrows the opener's handle. Closing it here would pull the
    // database out from under the store that actually owns it.
    if (this.#ownsDb) this.#db.close();
  }

  // -------------------------------------------------------------------------
  // SQLite mechanics. Everything above speaks in domain shapes; only these
  // helpers know that the store is a database at all.
  // -------------------------------------------------------------------------

  #countConnectors(): number {
    const row = this.#get<{ n: number }>(
      `SELECT count(*) AS n FROM connectors WHERE customer_id = $customer`,
    );
    return row?.n ?? 0;
  }

  /** `delivery_mode` is a free-text column; anything unrecognized reads as `"poll"`. */
  #toDirective(row: DirectiveRow): ConnectorDirective {
    return {
      workload: row.workload,
      pushedVersion: row.pushed_version,
      pushedAtMs: row.pushed_at_ms,
      ackedVersion: row.acked_version,
      ackedAtMs: row.acked_at_ms,
      deliveryMode: row.delivery_mode === "push" ? "push" : "poll",
    };
  }

  #readReservationVersion(): number {
    const row = this.#get<VersionRow>(
      `SELECT version FROM reservation_document WHERE customer_id = $customer`,
    );
    return row?.version ?? 0;
  }

  #readVersion(): number {
    const row = this.#get<VersionRow>(
      `SELECT version FROM target_document WHERE customer_id = $customer`,
    );
    return row?.version ?? 0;
  }

  /**
   * Run `body` inside an immediate transaction.
   *
   * `BEGIN IMMEDIATE` rather than the default deferred begin: it acquires the write lock
   * up front, so a compare inside the transaction cannot be invalidated by another process
   * between the read and the write. That is the difference between a compare-and-set and a
   * read-then-hope.
   */
  #transact<T>(body: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    let result: T;
    try {
      result = body();
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // The original error is what the caller needs; a failed rollback would mask it.
      }
      throw this.#unavailable("target store transaction failed", error);
    }
    try {
      this.#db.exec("COMMIT");
    } catch (cause) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Same reasoning as above.
      }
      throw this.#unavailable("target store commit failed", cause);
    }
    return result;
  }

  /**
   * Bind the caller's parameters plus the customer this instance is scoped to.
   *
   * Every statement gets `$customer` whether it asked for one or not, and `node:sqlite`
   * throws on a named parameter the SQL does not mention. That inverted default is what
   * makes the scoping mechanical: forgetting `customer_id = $customer` in a WHERE clause is
   * not a silent cross-customer read, it is an immediate failure on the first execution.
   */
  #bind(params: SqlParams): Record<string, SqlValue> {
    return { ...params, customer: this.#customerId };
  }

  #run(sql: string, params: SqlParams = {}): void {
    try {
      this.#db.prepare(sql).run(this.#bind(params));
    } catch (cause) {
      throw this.#unavailable("target store write failed", cause);
    }
  }

  #get<T>(sql: string, params: SqlParams = {}): T | undefined {
    try {
      return this.#db.prepare(sql).get(this.#bind(params)) as T | undefined;
    } catch (cause) {
      throw this.#unavailable("target store read failed", cause);
    }
  }

  #all<T>(sql: string, params: SqlParams = {}): T[] {
    try {
      return this.#db.prepare(sql).all(this.#bind(params)) as T[];
    } catch (cause) {
      throw this.#unavailable("target store read failed", cause);
    }
  }

  /** Keep an already-typed failure intact rather than nesting it one level deeper. */
  #unavailable(message: string, cause: unknown): StoreUnavailableError {
    return cause instanceof StoreUnavailableError
      ? cause
      : new StoreUnavailableError(message, { cause });
  }
}
