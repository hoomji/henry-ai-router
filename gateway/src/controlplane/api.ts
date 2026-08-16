import type { IncomingMessage, ServerResponse } from "node:http";

import { DEFAULT_CUSTOMER_ID } from "../targets/store.js";
import type { ConnectorUsageRecord, TargetStore } from "../targets/store.js";
import type { TargetService } from "../targets/service.js";
import { computeRankedList } from "./rankedList.js";
import type { RankedList } from "./rankedList.js";
import { DirectiveScheduler } from "./directives.js";
import { usageOutcome } from "./usageOutcome.js";

/**
 * The connector-facing HTTP surface: the push stream, its acknowledgement, the polling
 * fallback, usage ingestion, and the admin mint.
 *
 * **The concession this module makes.** `management/api.ts` speaks in plain values and never
 * touches `node:http`, which is what makes every one of its status codes testable by calling
 * a function. This module cannot do that, and the reason is the stream: Server-Sent Events
 * is a response that stays open for the life of the connector and is written to long after
 * the handler returned, so there is no value a handler could return that expresses it. Like
 * `targets/store.ts` and its `node:sqlite` import, the concession is declared and then
 * confined — everything below the socket layer is somebody else's module. Deciding *what*
 * the list is belongs to `rankedList.ts`, deciding *whether and when* it is a new version
 * belongs to `directives.ts`, and both are pure and tested directly. What is left here is
 * bytes on a socket, authentication, and JSON shape checks.
 *
 * The dependency rule is unaffected: `controlplane/` sits beside `management/` as a sibling
 * of `server.ts`, imports `routing/` and `targets/`, and nothing under `routing/`,
 * `targets/`, or `providers/` imports it.
 */

/** The slice of `Config` this surface needs; `Config` satisfies it structurally. */
export interface ControlPlaneConfig {
  readonly adminToken: string | null;
  readonly pushDebounceMs: number;
  readonly sseDisabled: boolean;
}

export interface ControlPlaneDeps {
  readonly nowMs?: () => number;
}

const JSON_HEADERS = { "content-type": "application/json" } as const;

/**
 * How often the stream writes a comment nobody reads.
 *
 * Load balancers and proxies close a connection that has been silent, and a control plane
 * whose push channel died quietly is worse than one that never had a push channel — the
 * connector keeps serving traffic on a list it believes is current. The heartbeat is what
 * makes the silence between two routing changes distinguishable from a dead socket.
 */
const HEARTBEAT_MS = 15_000;

/** Paths this module owns. `server.ts` asks before touching management or the data path. */
export function isControlPlanePath(path: string): boolean {
  return (
    path === "/v1/connector/stream" ||
    path === "/v1/connector/ack" ||
    path === "/v1/connector/lists" ||
    path === "/v1/connector/usage" ||
    path === "/v1/admin/connectors"
  );
}

interface Connection {
  readonly customerId: string;
  readonly res: ServerResponse;
  readonly heartbeat: NodeJS.Timeout;
}

export class ControlPlane {
  readonly #config: ControlPlaneConfig;
  readonly #service: TargetService;
  readonly #nowMs: () => number;
  readonly #schedulers = new Map<string, DirectiveScheduler>();
  readonly #connections = new Set<Connection>();
  #timer: NodeJS.Timeout | null = null;
  #closed = false;

  constructor(config: ControlPlaneConfig, service: TargetService, deps: ControlPlaneDeps = {}) {
    this.#config = config;
    this.#service = service;
    this.#nowMs = deps.nowMs ?? (() => Date.now());

    // The push loop runs at the debounce interval rather than faster: the scheduler already
    // refuses to publish more often than that, so a tighter loop would only recompute lists
    // it is about to discard.
    this.#timer = setInterval(() => {
      try {
        this.pump();
      } catch (error) {
        // A control-plane failure must never take the process with it; the polling fallback
        // is exactly the mode this degrades into.
        console.error("[gateway] control plane push failed:", error);
      }
    }, Math.max(1, config.pushDebounceMs));
    this.#timer.unref();
  }

  /**
   * Recompute every connected customer's lists and write the ones that changed.
   *
   * Exposed rather than private so a test drives it with an explicit instant instead of
   * waiting out a real debounce window, the same affordance `TargetService.tick` offers.
   */
  pump(nowMs: number = this.#nowMs()): void {
    const customers = new Set<string>();
    for (const connection of this.#connections) customers.add(connection.customerId);

    for (const customerId of customers) {
      for (const list of this.#recompute(customerId, nowMs)) {
        this.#broadcast(customerId, list, nowMs);
      }
    }
  }

  handle(req: IncomingMessage, res: ServerResponse, path: string, body: string): void {
    if (path === "/v1/admin/connectors") {
      this.#handleMint(req, res, body);
      return;
    }

    const customerId = this.#authenticate(req);
    if (customerId === null) {
      respond(res, 401, { error: "unauthorized" });
      return;
    }

    switch (path) {
      case "/v1/connector/stream":
        this.#handleStream(req, res, customerId);
        return;
      case "/v1/connector/lists":
        this.#handleLists(req, res, customerId);
        return;
      case "/v1/connector/ack":
        this.#handleAck(res, customerId, body);
        return;
      case "/v1/connector/usage":
        this.#handleUsage(res, customerId, body);
        return;
      default:
        respond(res, 404, { error: "not found" });
    }
  }

  /**
   * Close every stream.
   *
   * An SSE response holds a socket and a heartbeat timer, so a stream that outlives its
   * server keeps the event loop alive and keeps writing into a server that is gone. The
   * server's `close` event is wired to this for the same reason it is wired to
   * `TargetService.stop`: the control plane must not outlive the socket it was created for.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    for (const connection of [...this.#connections]) {
      this.#drop(connection);
    }
  }

  // -------------------------------------------------------------------------
  // Endpoints
  // -------------------------------------------------------------------------

  #handleStream(req: IncomingMessage, res: ServerResponse, customerId: string): void {
    if (req.method !== "GET") {
      respond(res, 405, { error: "method not allowed" });
      return;
    }
    if (this.#config.sseDisabled) {
      // Not an error condition to hide: the connector's documented response to a refused
      // stream is to poll, and being able to force that without a firewall rule is how the
      // degraded mode gets exercised at all.
      respond(res, 503, { error: "stream disabled", detail: "poll /v1/connector/lists" });
      return;
    }

    const nowMs = this.#nowMs();
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": ping\n\n");
    }, HEARTBEAT_MS);
    heartbeat.unref();

    const connection: Connection = { customerId, res, heartbeat };
    this.#connections.add(connection);
    // Both events fire in practice depending on who hung up first; `#drop` is idempotent.
    res.on("close", () => this.#drop(connection));
    req.on("close", () => this.#drop(connection));

    // The burst on connect is what makes a reconnect self-healing: the connector never has
    // to ask what it missed, and never runs on a fallback longer than one round trip.
    this.#recompute(customerId, nowMs);
    for (const list of this.#schedulerFor(customerId).current()) {
      this.#write(connection, list, nowMs);
    }
  }

  #handleLists(req: IncomingMessage, res: ServerResponse, customerId: string): void {
    if (req.method !== "GET") {
      respond(res, 405, { error: "method not allowed" });
      return;
    }

    const nowMs = this.#nowMs();
    this.#recompute(customerId, nowMs);
    const lists = this.#schedulerFor(customerId).current();

    // Serving a list here is a delivery, and it is the *poll* kind. Recording the mode is
    // what later makes "this connector is on the degraded path" a fact the status resource
    // reports rather than an inference from a missing stream.
    for (const list of lists) {
      this.#recordDelivery(customerId, list, "poll", nowMs);
    }
    respond(res, 200, { lists });
  }

  #handleAck(res: ServerResponse, customerId: string, body: string): void {
    const parsed = parseObject(body);
    if (parsed === null) {
      respond(res, 400, { error: "body must be a JSON object" });
      return;
    }
    const workload = parsed["workload"];
    const version = parsed["version"];
    if (typeof workload !== "string" || typeof version !== "number" || !Number.isInteger(version)) {
      respond(res, 400, { error: "workload must be a string and version an integer" });
      return;
    }

    const store = this.#storeFor(customerId);
    if (store === null) {
      respond(res, 503, { error: "target store unavailable" });
      return;
    }

    // `404` rather than an invented row: acking a list the gateway never delivered is a
    // connector bug, and materializing a directive for it would make the ack delay a
    // measurement of nothing.
    const known = this.#safe(() => store.recordDirectiveAck(workload, version, this.#nowMs()));
    if (known !== true) {
      respond(res, 404, { error: `no delivered list for workload ${workload}` });
      return;
    }
    res.writeHead(204);
    res.end();
  }

  /**
   * Ingest a usage batch, and answer `204` almost unconditionally.
   *
   * The contract's rule is absolute: reporting must never be able to fail a customer's
   * request path. A connector that receives a `4xx` for one bad record has to decide whether
   * to retry the batch, and every answer to that question ends with reporting backpressure
   * reaching the caller's request. So malformed records are dropped one at a time and the
   * good ones are stored, and even an unparseable body is acknowledged — the gateway logs
   * it, which is the right place for a bug in a reporting client to surface.
   */
  #handleUsage(res: ServerResponse, customerId: string, body: string): void {
    const parsed = parseObject(body);
    const rawRecords = parsed === null ? null : parsed["records"];
    const records: ConnectorUsageRecord[] = [];
    let dropped = 0;

    if (Array.isArray(rawRecords)) {
      for (const raw of rawRecords) {
        const record = parseUsageRecord(raw);
        if (record === null) dropped += 1;
        else records.push(record);
      }
    } else if (parsed === null) {
      console.warn("[gateway] connector usage report was not a JSON object; dropped");
    }

    if (dropped > 0) {
      console.warn(`[gateway] dropped ${dropped} malformed usage record(s) from ${customerId}`);
    }

    const store = this.#storeFor(customerId);
    if (store !== null && records.length > 0) {
      this.#safe(() => store.writeConnectorUsage(records));
    }
    this.#measure(customerId, records);
    res.writeHead(204);
    res.end();
  }

  /**
   * Fold reported calls into the measurement windows.
   *
   * Persisting a usage record bills for it; this is what makes it *evidence*. With the
   * gateway out of the request path these reports are the only thing feeding the rolling
   * windows, so without this step the control plane would price traffic it had no measured
   * opinion about: every provider would stay `insufficient_data`, the ranked list would
   * never reorder on observed behavior, and `unmet` could not be reached at all except by
   * driving the gateway's own data path — which in normal operation carries nothing.
   *
   * Only the service's own customer is folded in. The rolling windows are keyed by
   * (workload, provider) and know nothing about customers, so mixing two customers' traffic
   * would not fail loudly — it would silently average one customer's providers into
   * another's target. Measuring per customer is a data-model change of the same kind
   * behavior 3's cohort membership needs, and this milestone's decision is explicit that it
   * adds authentication and per-customer scoping only. Reporting from another customer is
   * therefore stored and billed, but not measured, and says so once rather than per record.
   */
  #measure(customerId: string, records: readonly ConnectorUsageRecord[]): void {
    if (records.length === 0) return;
    if (customerId !== DEFAULT_CUSTOMER_ID) {
      console.warn(
        `[gateway] usage from ${customerId} was stored but not measured: per-customer ` +
          `measurement windows are deferred with cohort multi-tenancy`,
      );
      return;
    }

    const context = {
      // Any workload name yields the same catalogue; the providers a gateway can reach are
      // not a property of the workload asking.
      providers: this.#service.providerState("default").providers,
      liveReservations: this.#service.liveReservations(this.#nowMs()),
    };

    let unpriceable = 0;
    for (const record of records) {
      const result = usageOutcome(record, context);
      if ("outcome" in result) {
        this.#service.record(result.outcome);
      } else if (result.dropped === "unpriceable") {
        unpriceable += 1;
      }
    }

    if (unpriceable > 0) {
      // Worth a line: it means a connector is calling a provider this gateway has no
      // catalogue entry for, so that traffic is invisible to every target it states.
      console.warn(
        `[gateway] ${unpriceable} reported call(s) could not be priced and were not measured`,
      );
    }
  }

  /**
   * Mint a connector credential.
   *
   * `404` when no admin token is configured, not `401` or `403`: an operator who never set
   * the variable has not decided to run credential minting without authentication, so the
   * endpoint is absent rather than closed.
   */
  #handleMint(req: IncomingMessage, res: ServerResponse, body: string): void {
    const adminToken = this.#config.adminToken;
    if (adminToken === null) {
      respond(res, 404, { error: "not found" });
      return;
    }
    if (req.method !== "POST") {
      respond(res, 405, { error: "method not allowed" });
      return;
    }
    if (bearerToken(req) !== adminToken) {
      respond(res, 401, { error: "unauthorized" });
      return;
    }

    const parsed = parseObject(body);
    const customerId = parsed === null ? undefined : parsed["customerId"];
    if (typeof customerId !== "string" || customerId.trim() === "") {
      respond(res, 400, { error: "customerId is required and must be a non-empty string" });
      return;
    }

    const store = this.#storeFor(customerId);
    if (store === null) {
      respond(res, 503, { error: "target store unavailable" });
      return;
    }
    const record = this.#safe(() => store.mintConnector(this.#nowMs()));
    if (record === null) {
      respond(res, 503, { error: "target store unavailable" });
      return;
    }
    respond(res, 201, record);
  }

  // -------------------------------------------------------------------------
  // Socket and store mechanics
  // -------------------------------------------------------------------------

  /** Recompute this customer's lists and return the versions that became current now. */
  #recompute(customerId: string, nowMs: number): RankedList[] {
    const document = this.#service.document();
    if (document === null) return [];

    const scheduler = this.#schedulerFor(customerId);
    const published: RankedList[] = [];
    for (const name of Object.keys(document.workloads)) {
      const draft = computeRankedList(name, this.#service.providerState(name), {
        unmetDimension: this.#service.unmetDimension(name),
        computedAtMs: nowMs,
      });
      const list = scheduler.offer(draft, nowMs);
      if (list !== null) published.push(list);
    }
    published.push(...scheduler.flush(nowMs));
    return published;
  }

  #broadcast(customerId: string, list: RankedList, nowMs: number): void {
    for (const connection of this.#connections) {
      if (connection.customerId !== customerId) continue;
      this.#write(connection, list, nowMs);
    }
  }

  #write(connection: Connection, list: RankedList, nowMs: number): void {
    if (connection.res.writableEnded) return;
    // One event, one line of data: a RankedList containing a newline would split the frame,
    // and `JSON.stringify` never emits a raw newline, so the invariant holds by construction.
    connection.res.write(`event: list\ndata: ${JSON.stringify(list)}\n\n`);
    this.#recordDelivery(connection.customerId, list, "push", nowMs);
  }

  #recordDelivery(customerId: string, list: RankedList, mode: "push" | "poll", nowMs: number): void {
    const store = this.#storeFor(customerId);
    if (store === null) return;
    this.#safe(() => store.recordDirectiveDelivery(list.workload, list.version, mode, nowMs));
  }

  #drop(connection: Connection): void {
    if (!this.#connections.delete(connection)) return;
    clearInterval(connection.heartbeat);
    if (!connection.res.writableEnded) connection.res.end();
  }

  #schedulerFor(customerId: string): DirectiveScheduler {
    const existing = this.#schedulers.get(customerId);
    if (existing !== undefined) return existing;
    const created = new DirectiveScheduler({
      debounceMs: this.#config.pushDebounceMs,
      readPersistedVersion: (workload) => {
        const store = this.#storeFor(customerId);
        if (store === null) return 0;
        return this.#safe(() => store.readDirective(workload))?.pushedVersion ?? 0;
      },
    });
    this.#schedulers.set(customerId, created);
    return created;
  }

  #authenticate(req: IncomingMessage): string | null {
    const token = bearerToken(req);
    if (token === null) return null;
    // Resolution is the one query that cannot be customer-scoped, because it is what
    // produces the scope. Everything after this line goes through `storeFor`.
    const store = this.#storeFor(DEFAULT_CUSTOMER_ID);
    if (store === null) return null;
    return this.#safe(() => store.resolveConnectorCustomer(token));
  }

  #storeFor(customerId: string): TargetStore | null {
    return this.#service.storeFor(customerId);
  }

  /**
   * Run a store call, degrading to `null` rather than throwing.
   *
   * An unreadable store must not make the connector surface throw: the connector is already
   * serving traffic on the last list it received, and the correct behavior is for the
   * control plane to go quiet, not for it to start failing calls the connector will retry.
   */
  #safe<T>(body: () => T): T | null {
    try {
      return body();
    } catch (error) {
      console.error("[gateway] control plane store access failed:", error);
      return null;
    }
  }
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers["authorization"];
  const value = Array.isArray(header) ? header[0] : header;
  if (value === undefined) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(value.trim());
  return match?.[1] ?? null;
}

function parseObject(body: string): Record<string, unknown> | null {
  if (body.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

/**
 * Validate one reported provider call, or reject it alone.
 *
 * Every field is checked rather than trusted because these rows are the only evidence the
 * gateway has of traffic it never saw: a record with a string where a token count belongs
 * would either fail the store's insert — taking the whole batch's transaction with it — or
 * land and corrupt the totals the status resource reports.
 */
function parseUsageRecord(raw: unknown): ConnectorUsageRecord | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const workload = record["workload"];
  const providerId = record["providerId"];
  const model = record["model"];
  const region = record["region"];
  if (
    typeof workload !== "string" ||
    typeof providerId !== "string" ||
    typeof model !== "string" ||
    typeof region !== "string"
  ) {
    return null;
  }

  const promptTokens = finiteInteger(record["promptTokens"]);
  const completionTokens = finiteInteger(record["completionTokens"]);
  const latencyMs = finiteInteger(record["latencyMs"]);
  const statusCode = finiteInteger(record["statusCode"]);
  const atMs = finiteInteger(record["atMs"]);
  if (
    promptTokens === null ||
    completionTokens === null ||
    latencyMs === null ||
    statusCode === null ||
    atMs === null
  ) {
    return null;
  }

  return {
    workload,
    providerId,
    model,
    region,
    promptTokens,
    completionTokens,
    latencyMs,
    statusCode,
    // Absent and null are the same thing here: the provider returned no such header.
    rateLimitLimit: optionalString(record["rateLimitLimit"]),
    rateLimitReset: optionalString(record["rateLimitReset"]),
    reservationId: optionalString(record["reservationId"]),
    atMs,
  };
}

function finiteInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.trunc(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
