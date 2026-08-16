import { chooseProvider } from "../routing/chooseProvider.js";
import { DEFAULT_WINDOW_CONFIG, RollingWindows, mergeObservations } from "../routing/stats.js";
import { INSUFFICIENT_DATA } from "../types.js";
import { parseTargetDocument, serializeTargetDocument, TargetDocumentError } from "./document.js";
import { checkFeasibility } from "./feasibility.js";
import { ackDelayMs, StoreUnavailableError, TargetStore } from "./store.js";
import type { DeliveryMode } from "./store.js";
import { foldWindow, restoreState } from "./unmet.js";
import { reservationIsLive } from "../types.js";
import {
  parseReservationDocument,
  ReservationDocumentError,
} from "../reservations/document.js";
import { unaddressedCapacity } from "../reservations/unaddressed.js";
import type { UnaddressedReport } from "../reservations/unaddressed.js";
import type {
  DimensionName,
  Measured,
  Provider,
  ProviderObservation,
  ProviderState,
  RequestOutcome,
  Reservation,
  ReservationDocument,
  TargetDocument,
  UnmetState,
  Workload,
} from "../types.js";

/**
 * The one place the target apparatus is assembled.
 *
 * It owns the store, the in-memory copy of the document, the rolling windows, and the
 * `unmet` state machine, and it is what both the data path and the management surfaces
 * talk to. It lives under `targets/` rather than `management/` because the data path needs
 * it too, and `server.ts` may import `targets/` while nothing under `targets/` may import
 * `server.ts` or `management/`. That is why the notification is delivered through an
 * injected callback rather than by importing `management/notify.ts`: the dependency rule
 * points one way, and a convenience import would be the first crack in it.
 *
 * The other rule it exists to enforce: **the data path never reads the store**. Requests
 * are served from `#document` and `#observations`, both refreshed by a timer. A `200` on
 * `PUT /v1/targets` therefore means *committed*, not *in force in every process*, and the
 * spec's boundary is that the change takes effect within approximately five seconds
 * (docs/adr/0002-durable-target-store-with-cross-process-concurrency.md).
 */

/** What a management write produced. Status codes are the caller's to send. */
export type PutResult =
  | { readonly status: 200; readonly document: TargetDocument }
  | { readonly status: 409; readonly currentVersion: number }
  | { readonly status: 422; readonly body: unknown }
  | { readonly status: 400; readonly message: string }
  | { readonly status: 503; readonly message: string };

/** One dimension's line on the status resource. */
export interface DimensionStatus {
  readonly dimension: DimensionName;
  readonly target: number;
  readonly observed: Measured;
  readonly windowSpanMs: number;
  readonly windowRequestCount: number;
}

/**
 * What the connector reported about traffic the gateway never saw.
 *
 * This is the half of the status resource that cannot be derived from anything the gateway
 * observed itself. The connector calls providers directly, so token counts and the latency
 * those providers were actually responsible for exist here only because they were reported
 * back — which makes this section the readable proof that the reporting path is alive.
 */
export interface WorkloadUsageStatus {
  readonly requestCount: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /**
   * The p95 of the connector's own provider-attributable latencies, or
   * `insufficient_data`.
   *
   * Distinct from the `p95_ms` dimension above, which is measured over requests the gateway
   * forwarded. When the connector is carrying the traffic, this is the only number that
   * reflects what the customer's callers actually waited for.
   */
  readonly providerLatencyP95Ms: Measured;
}

/**
 * Whether the list the gateway computed is the list a connector is running.
 *
 * The gap between `pushedVersion` and `ackedVersion` is the only honest answer to "is my
 * routing in force", and `ackDelayMs` is how the degraded mode becomes detectable: a pushed
 * list is acked within a round trip, a polled one waits out the connector's poll interval.
 */
export interface DirectiveStatus {
  readonly pushedVersion: number;
  readonly pushedAtMs: number;
  readonly ackedVersion: number | null;
  readonly ackedAtMs: number | null;
  readonly deliveryMode: DeliveryMode;
  readonly ackDelayMs: number | null;
}

/**
 * The authoritative record of a workload's current state.
 *
 * Authoritative is the operative word: the notification may be dropped and the response
 * header is written by whoever served the request, but this resource is the truth both are
 * derived from.
 */
export interface StatusResource {
  readonly workload: string;
  readonly version: number;
  readonly unmet: boolean;
  readonly since: number | null;
  readonly report: unknown;
  readonly dimensions: readonly DimensionStatus[];
  /**
   * Set when the target was accepted against a capability floor that has since been
   * corrected, or accepted only because every candidate floor was stale. The spec forbids
   * a third infeasibility state for "our floor was wrong" — the state stays `unmet` and
   * the correction is reported here instead.
   */
  readonly feasibilityNote: string | null;
  /** Connector-reported traffic. Zeroed, never omitted, when nothing has been reported. */
  readonly usage: WorkloadUsageStatus;
  /** `null` until a list has been delivered for this workload. */
  readonly directive: DirectiveStatus | null;
  /**
   * One entry per declared reservation, with its utilization and the cause of any gap.
   *
   * Empty, never omitted, when the customer has declared none. This is the reporting half of
   * behavior 4: routing onto reserved capacity is invisible unless the customer can see the
   * capacity their traffic is walking past, and *why*.
   */
  readonly reservations: readonly UnaddressedReport[];
}

export type TransitionListener = (
  transition: "entered" | "left",
  state: UnmetState,
  document: TargetDocument,
) => void;

export interface ServiceConfig {
  readonly storePath: string;
  readonly pollMs: number;
  readonly windowMs: number;
  readonly windowMinRequests: number;
  readonly sampleFloor: number;
  readonly providers: readonly Provider[];
}

export interface ServiceDeps {
  readonly onTransition?: TransitionListener;
  readonly nowMs?: () => number;
  readonly processId?: string;
}

const SYNTHETIC_REQUEST = {
  method: "POST",
  path: "/v1/chat/completions",
  headers: {},
  body: "",
} as const;

export class TargetService {
  readonly #config: ServiceConfig;
  readonly #nowMs: () => number;
  readonly #onTransition: TransitionListener | null;
  readonly #store: TargetStore | null;
  readonly #storeError: string | null;
  readonly #windows: RollingWindows;
  #document: TargetDocument | null = null;
  #version = 0;
  #reservations: ReservationDocument | null = null;
  #reservationVersion = 0;
  #observations: Map<string, Record<string, ProviderObservation>> = new Map();
  #unmet: Map<string, UnmetState> = new Map();
  #timer: NodeJS.Timeout | null = null;

  private constructor(config: ServiceConfig, deps: ServiceDeps) {
    this.#config = config;
    this.#nowMs = deps.nowMs ?? (() => Date.now());
    this.#onTransition = deps.onTransition ?? null;
    this.#windows = new RollingWindows(deps.processId ?? `pid-${process.pid}`, {
      ...DEFAULT_WINDOW_CONFIG,
      spanMs: config.windowMs,
      minRequests: config.windowMinRequests,
      sampleFloor: config.sampleFloor,
    });

    let store: TargetStore | null = null;
    let storeError: string | null = null;
    try {
      store = TargetStore.open(config.storePath);
    } catch (error) {
      // The process starts anyway. It serves the data path as pure passthrough and fails
      // the management surfaces with 503 — an unreadable store and a customer who has
      // stated no targets must not look alike, so it never synthesizes an empty document.
      storeError =
        error instanceof StoreUnavailableError
          ? `target store unavailable: ${error.message}`
          : `target store failed to open: ${String(error)}`;
      console.error(`[gateway] ${storeError}`);
    }
    this.#store = store;
    this.#storeError = storeError;
  }

  static start(config: ServiceConfig, deps: ServiceDeps = {}): TargetService {
    const service = new TargetService(config, deps);
    service.#refresh();
    service.#restoreUnmet();
    service.#timer = setInterval(() => {
      try {
        service.tick(service.#nowMs());
      } catch (error) {
        // A failure in the control plane must never take the data path with it.
        console.error("[gateway] target service tick failed:", error);
      }
    }, config.pollMs);
    service.#timer.unref();
    return service;
  }

  /** True when the store could not be opened: management fails, forwarding continues. */
  get degraded(): boolean {
    return this.#store === null;
  }

  get storeError(): string | null {
    return this.#storeError;
  }

  get version(): number {
    return this.#version;
  }

  document(): TargetDocument | null {
    return this.#document;
  }

  workload(name: string): Workload | null {
    const document = this.#document;
    if (document === null) return null;
    return document.workloads[name] ?? document.workloads["default"] ?? null;
  }

  // -------------------------------------------------------------------------
  // Management surface
  // -------------------------------------------------------------------------

  /**
   * Replace the whole document.
   *
   * A whole-document replace rather than a field-level merge, and a `409` that is terminal:
   * the gateway never retries a rejected write on the client's behalf, because a merge
   * would have to guess which of two customers' intents wins.
   */
  put(raw: unknown, expectedVersion: number, nowMs: number = this.#nowMs()): PutResult {
    const store = this.#store;
    if (store === null) {
      return { status: 503, message: this.#storeError ?? "target store unavailable" };
    }

    let parsed: TargetDocument;
    try {
      parsed = parseTargetDocument(raw, expectedVersion + 1);
    } catch (error) {
      if (error instanceof TargetDocumentError) {
        return { status: 400, message: error.message };
      }
      throw error;
    }

    // Declaration-time feasibility is checked synchronously on every write, before the
    // document is committed: the whole point of `infeasible_by_declaration` is that it is
    // knowable before any traffic flows.
    const reports = [];
    const abstentions: string[] = [];
    for (const workload of Object.values(parsed.workloads)) {
      const result = checkFeasibility(workload, nowMs);
      if (result.status === "infeasible") reports.push(...result.reports);
      else if (result.status === "abstained") abstentions.push(result.detail);
    }
    if (reports.length > 0) {
      return { status: 422, body: { error: "infeasible_by_declaration", reports } };
    }

    const receipt = {
      writtenAtMs: nowMs,
      // A rejection that abstained is recorded with the document it accepted, because the
      // spec requires the abstention to be observable rather than silent.
      abstentions,
    };
    const result = store.writeDocument(expectedVersion, parsed, receipt);
    if (!result.ok) return { status: 409, currentVersion: result.version };

    this.#refresh();
    return { status: 200, document: this.#document ?? parsed };
  }

  get(): PutResult | { readonly status: 200; readonly document: TargetDocument | null } {
    if (this.#store === null) {
      return { status: 503, message: this.#storeError ?? "target store unavailable" };
    }
    return { status: 200, document: this.#document };
  }

  /**
   * The authoritative current state of one workload.
   *
   * Feasibility is re-checked at read time rather than remembered from the write. That is
   * what makes two of the spec's criteria fall out for free: a floor correction leaves the
   * document valid and in force while flagging the affected workload here, and an
   * abstention stays visible for as long as it is true.
   */
  status(name: string, nowMs: number = this.#nowMs()): StatusResource | null {
    const document = this.#document;
    if (document === null) return null;
    const workload = document.workloads[name];
    if (workload === undefined) return null;

    const observations = this.#observations.get(name) ?? {};
    const merged = Object.values(observations);
    const dimensions: DimensionStatus[] = [];
    for (const dimension of workload.declarationOrder) {
      const target = workload.dimensions[dimension];
      if (target === undefined) continue;
      dimensions.push({
        dimension,
        target,
        observed: bestObserved(merged, dimension),
        windowSpanMs: merged[0]?.windowSpanMs ?? 0,
        windowRequestCount: merged.reduce((sum, observation) => sum + observation.sampleCount, 0),
      });
    }

    const state = this.#unmet.get(name) ?? null;
    const feasibility = checkFeasibility(workload, nowMs);
    let note: string | null = null;
    if (feasibility.status === "abstained") {
      note = feasibility.detail;
    } else if (feasibility.status === "infeasible") {
      const first = feasibility.reports[0];
      note =
        first === undefined
          ? "a capability floor this target was accepted against has since been corrected"
          : `accepted against a capability floor since corrected: ${first.dimension} now floors at ` +
            `${first.bestAchievable} on ${first.providerId} (${first.floorProvenance}), and this ` +
            `target requests ${first.requested}. The document stays valid and in force until you write it.`;
    }

    return {
      workload: name,
      version: document.version,
      unmet: state?.unmet ?? false,
      since: state?.since ?? null,
      report: state?.report ?? null,
      dimensions,
      feasibilityNote: note,
      usage: this.#usageStatus(name, nowMs),
      directive: this.#directiveStatus(name),
      reservations: this.#reservationStatus(name, nowMs),
    };
  }

  // -------------------------------------------------------------------------
  // Reservations
  // -------------------------------------------------------------------------

  get reservationVersion(): number {
    return this.#reservationVersion;
  }

  /** The declared reservations, or `null` when the customer has never written the document. */
  reservationDocument(): ReservationDocument | null {
    return this.#reservations;
  }

  /**
   * Replace the whole reservation document.
   *
   * Deliberately the same shape as `put`, down to the terminal `409`: two resources with the
   * same optimistic-concurrency contract should not require the customer to learn two
   * stories about what a conflict means. What it does *not* share is the feasibility check —
   * a reservation states a fact about a contract the customer has already signed, and there
   * is nothing for the gateway to find infeasible about it.
   */
  putReservations(raw: unknown, expectedVersion: number): PutResult | {
    readonly status: 200;
    readonly reservations: ReservationDocument;
  } {
    const store = this.#store;
    if (store === null) {
      return { status: 503, message: this.#storeError ?? "target store unavailable" };
    }

    let parsed: ReservationDocument;
    try {
      parsed = parseReservationDocument(raw, expectedVersion + 1);
    } catch (error) {
      if (error instanceof ReservationDocumentError) {
        return { status: 400, message: error.message };
      }
      throw error;
    }

    const result = store.writeReservations(expectedVersion, parsed);
    if (!result.ok) return { status: 409, currentVersion: result.version };

    this.#refreshReservations();
    return { status: 200, reservations: this.#reservations ?? parsed };
  }

  /**
   * The reservations whose term covers `nowMs`.
   *
   * The single place term liveness is decided, and it is here rather than in `chooseProvider`
   * because this is a component that already owns a clock. Everything downstream — the
   * routing preference, the ranked list's addressing string — receives the answer as data.
   */
  liveReservations(nowMs: number = this.#nowMs()): readonly Reservation[] {
    const document = this.#reservations;
    if (document === null) return [];
    return document.reservations.filter((reservation) => reservationIsLive(reservation, nowMs));
  }

  /** The `unmet` dimension a response header should carry, or `null`. */
  unmetDimension(name: string): DimensionName | null {
    const state = this.#unmet.get(name);
    if (state === undefined || !state.unmet) return null;
    return state.report?.dimension ?? null;
  }

  /**
   * The store, scoped to one customer, or `null` when it could not be opened.
   *
   * The one accessor that hands the handle out, and it exists for the connector surface:
   * `controlplane/` resolves a bearer token to a customer and must then read and write that
   * customer's rows, which the service's own default-scoped handle cannot do. It returns a
   * `forCustomer` view rather than the raw handle so the caller still cannot write an
   * unscoped query, and the ownership rule holds — only `stop()` closes the real one.
   */
  storeFor(customerId: string): TargetStore | null {
    return this.#store === null ? null : this.#store.forCustomer(customerId);
  }

  // -------------------------------------------------------------------------
  // Data path
  // -------------------------------------------------------------------------

  /** The snapshot `chooseProvider` is pure over. Built from memory, never from the store. */
  providerState(workloadName: string, nowMs: number = this.#nowMs()): ProviderState {
    return {
      providers: this.#config.providers,
      observations: this.#observations.get(workloadName) ?? {},
      workload: this.workload(workloadName),
      // Resolved here, so the seam stays pure. An expired term simply stops appearing.
      liveReservations: this.liveReservations(nowMs),
    };
  }

  record(outcome: RequestOutcome): void {
    this.#windows.record(outcome);
  }

  // -------------------------------------------------------------------------
  // The timer's work
  // -------------------------------------------------------------------------

  /**
   * Close due windows, publish their summaries, and advance the `unmet` machine.
   *
   * Exposed rather than private so tests drive it with an explicit clock instead of
   * waiting on a timer.
   */
  tick(nowMs: number): void {
    this.#refresh();
    const store = this.#store;
    if (store === null) return;

    const closed = this.#windows.closeDue(nowMs);
    const touched = new Set<string>();
    for (const summary of closed) {
      store.writeWindowSummary(summary);
      touched.add(summary.workload);
    }

    // A dead process's rows age out by timestamp rather than by liveness detection: no
    // heartbeat, no leader election, nothing to get wrong during a deploy.
    store.pruneWindowSummaries(nowMs - this.#config.windowMs * 3);

    const document = this.#document;
    if (document === null) return;

    for (const name of Object.keys(document.workloads)) {
      // Two lookbacks, deliberately different, because they answer different questions.
      //
      // What routing and the status resource report is a *trailing* measurement — the
      // spec's window is 5 minutes or 200 requests, so folding the last few closed windows
      // together is what that window actually means. A single closed window would make the
      // evidence evaporate moments after it was gathered, sending every provider back to
      // `insufficient_data` and re-triggering exploration on traffic we had just measured.
      const trailing = store.readWindowSummaries(name, nowMs - this.#config.windowMs * 3);
      const observations = mergeObservations(trailing, this.#config.sampleFloor);
      this.#observations.set(name, observations);
      if (!touched.has(name)) continue;

      const workload = document.workloads[name];
      if (workload === undefined) continue;

      // The state machine, by contrast, judges *the window that just closed*. Folding
      // older ones back in would mean a recovered workload was still being judged on the
      // windows it already recovered from, which would break the deliberate symmetry of
      // the two-window entry and the two-window exit.
      const judged = mergeObservations(
        store.readWindowSummaries(name, nowMs - this.#config.windowMs),
        this.#config.sampleFloor,
      );
      this.#advanceUnmet(store, workload, judged, nowMs, document);
    }
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#store?.close();
  }

  // -------------------------------------------------------------------------

  #advanceUnmet(
    store: TargetStore,
    workload: Workload,
    observations: Record<string, ProviderObservation>,
    nowMs: number,
    document: TargetDocument,
  ): void {
    const merged = Object.values(observations);
    const decision = chooseProvider(SYNTHETIC_REQUEST, {
      providers: this.#config.providers,
      observations,
      workload,
      // The `unmet` machine has to judge the same policy the data path executes. Leaving
      // reservations out here would report a cost target as unmet at the public rate while
      // routing was in fact holding it at the reserved one.
      liveReservations: this.liveReservations(nowMs),
    });

    const previous = store.readUnmetState(workload.name);
    const evaluation = foldWindow(previous, workload, merged, decision.rejected, {
      closedAtMs: nowMs,
      spanMs: merged[0]?.windowSpanMs ?? this.#config.windowMs,
      requestCount: merged.reduce((sum, observation) => sum + observation.sampleCount, 0),
    });

    // The transition is a compare-and-set: the process that wins it is the one that
    // notifies, and the others observe the state move and stay silent. One primitive
    // covers both the document's `409` and this de-duplication.
    const won = store.casUnmetState(workload.name, previous, evaluation.state);
    if (!won) {
      const current = store.readUnmetState(workload.name);
      if (current !== null) this.#unmet.set(workload.name, current);
      return;
    }

    this.#unmet.set(workload.name, evaluation.state);
    if (evaluation.transition !== null && this.#onTransition !== null) {
      this.#onTransition(evaluation.transition, evaluation.state, document);
    }
  }

  /**
   * Roll up what the connector reported for one workload over the trailing window.
   *
   * The same lookback the observations use, so the two halves of the status resource
   * describe the same span of time. Totals come from the store's aggregate — the row count
   * grows with traffic while the answer stays one row — but the latency percentile needs the
   * individual samples, which is why that one reads rows. The table is pruned on the same
   * schedule as the window summaries, so the read is bounded by the window rather than by
   * how long the gateway has been running.
   */
  #usageStatus(name: string, nowMs: number): WorkloadUsageStatus {
    const empty: WorkloadUsageStatus = {
      requestCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      providerLatencyP95Ms: INSUFFICIENT_DATA,
    };
    const store = this.#store;
    if (store === null) return empty;

    const sinceMs = nowMs - this.#config.windowMs * 3;
    try {
      const totals = store.readUsageTotals(sinceMs).find((entry) => entry.workload === name);
      if (totals === undefined) return empty;

      const latencies = store
        .readConnectorUsage(sinceMs)
        .filter((record) => record.workload === name)
        .map((record) => record.latencyMs);

      return {
        requestCount: totals.requestCount,
        promptTokens: totals.promptTokens,
        completionTokens: totals.completionTokens,
        providerLatencyP95Ms: p95Of(latencies, this.#config.sampleFloor),
      };
    } catch (error) {
      // The status resource degrades to "nothing reported" rather than failing: a broken
      // usage read must not hide the target state, which is the part of this resource the
      // customer depends on.
      console.error("[gateway] connector usage read failed:", error);
      return empty;
    }
  }

  /**
   * Utilization for every declared reservation, over the same window the rest of the
   * resource reports.
   *
   * Scoped to this workload's reported calls, because the resource is per workload and a gap
   * attributed to the wrong workload sends the customer to the wrong call site — which is
   * the one thing this report exists to get right.
   */
  #reservationStatus(name: string, nowMs: number): readonly UnaddressedReport[] {
    const document = this.#reservations;
    if (document === null || document.reservations.length === 0) return [];

    const store = this.#store;
    if (store === null) return [];

    try {
      const sinceMs = nowMs - this.#config.windowMs * 3;
      const usage = store
        .readConnectorUsage(sinceMs)
        .filter((record) => record.workload === name);
      return unaddressedCapacity(document.reservations, usage, this.#config.providers, nowMs);
    } catch (error) {
      // Same degradation as the usage roll-up: a broken read must not hide the target state.
      console.error("[gateway] reservation utilization read failed:", error);
      return [];
    }
  }

  #directiveStatus(name: string): DirectiveStatus | null {
    const store = this.#store;
    if (store === null) return null;
    try {
      const directive = store.readDirective(name);
      if (directive === null) return null;
      return {
        pushedVersion: directive.pushedVersion,
        pushedAtMs: directive.pushedAtMs,
        ackedVersion: directive.ackedVersion,
        ackedAtMs: directive.ackedAtMs,
        deliveryMode: directive.deliveryMode,
        ackDelayMs: ackDelayMs(directive),
      };
    } catch (error) {
      console.error("[gateway] connector directive read failed:", error);
      return null;
    }
  }

  /**
   * Re-read the reservation document if its version moved.
   *
   * Versioned independently of the target document and refreshed on the same timer, which is
   * the mechanical expression of the Decision Log: declaring a reservation must not bump the
   * version of the document the customer authored their targets in, and vice versa.
   */
  #refreshReservations(): void {
    const store = this.#store;
    if (store === null) return;
    try {
      const version = store.readReservationVersion();
      if (version === this.#reservationVersion && this.#reservations !== null) return;
      this.#reservations = store.readReservations();
      this.#reservationVersion = version;
    } catch (error) {
      // The last known reservations stay in force, for the same reason the last known
      // document does: dropping them would silently move paid-for traffic back to on-demand.
      console.error("[gateway] reservation document refresh failed:", error);
    }
  }

  #refresh(): void {
    this.#refreshReservations();
    const store = this.#store;
    if (store === null) return;
    try {
      const version = store.readVersion();
      if (version === this.#version && this.#document !== null) return;
      this.#document = store.readDocument();
      this.#version = version;
    } catch (error) {
      // A store that breaks *after* boot leaves the last known document in force rather
      // than dropping targets mid-flight. Losing our opinion is survivable; losing the
      // customer's stated intent silently is not.
      console.error("[gateway] target document refresh failed:", error);
    }
  }

  #restoreUnmet(): void {
    const store = this.#store;
    const document = this.#document;
    if (store === null || document === null) return;
    const nowMs = this.#nowMs();
    for (const name of Object.keys(document.workloads)) {
      const restored = restoreState(store.readUnmetState(name), nowMs, this.#config.windowMs);
      if (restored !== null) this.#unmet.set(name, restored);
    }
  }
}

/**
 * The p95 of reported latencies, or `insufficient_data` below the sample floor.
 *
 * Same rule as every other measured dimension: the spec forbids reporting a percentile
 * computed from a handful of requests, and the connector's reports are no more trustworthy
 * a basis for one than the gateway's own.
 */
function p95Of(latencies: readonly number[], sampleFloor: number): Measured {
  if (latencies.length < sampleFloor) return INSUFFICIENT_DATA;
  const sorted = [...latencies].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[Math.max(0, index)] ?? INSUFFICIENT_DATA;
}

/** The best any allowed provider managed on a dimension, for the status resource. */
function bestObserved(
  observations: readonly ProviderObservation[],
  dimension: DimensionName,
): Measured {
  let best: Measured = INSUFFICIENT_DATA;
  for (const observation of observations) {
    const value =
      dimension === "p95_ms"
        ? observation.p95Ms
        : dimension === "cost_per_1k_tokens_usd"
          ? observation.costPer1kTokensUsd
          : observation.successRate;
    if (value === INSUFFICIENT_DATA) continue;
    if (best === INSUFFICIENT_DATA) {
      best = value;
      continue;
    }
    const better = dimension === "success_rate" ? value > best : value < best;
    if (better) best = value;
  }
  return best;
}
