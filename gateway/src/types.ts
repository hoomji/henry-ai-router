/**
 * Plain-data shapes shared across the gateway.
 *
 * Nothing here imports a server or framework type. The design doc's dependency rule
 * (docs/design-docs/gateway-design.md) rests on that: `routing/`, `targets/`, and
 * `providers/` speak only in these shapes, so a future Rust or Go data plane can
 * re-express them without inheriting Node's HTTP types.
 *
 * Time appears here only as an explicit `...Ms` number passed in by a caller. No module
 * under `routing/`, `targets/`, or `providers/` reads a clock; that is what keeps their
 * behavior reproducible in a test without faking global time.
 */

/** A provider the gateway can route to. */
export interface Provider {
  readonly id: string;
  /** Base URL of the upstream, without a trailing slash. */
  readonly baseUrl: string;
  /** The model this provider serves, matched against a workload's `allowed_models`. */
  readonly model: string;
  /** The host serving it (`bedrock`, `anthropic`, ...), the `@host` half of an entry. */
  readonly host: string;
  /** Region and service tier key the capability floor; both default in simulation. */
  readonly region: string;
  readonly serviceTier: string;
}

/** An inbound model call, normalized away from the wire. */
export interface GatewayRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The raw request body. Adapters parse it; the data path never does. */
  readonly body: string;
}

/** A response on its way back to the caller. */
export interface GatewayResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** An upstream call an adapter has described but not performed. */
export interface UpstreamRequest {
  readonly method: string;
  /** Path relative to the provider's base URL, leading slash included. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/** What an upstream returned, before the adapter translates it back. */
export interface UpstreamResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

// ---------------------------------------------------------------------------
// Target vocabulary
// ---------------------------------------------------------------------------

/**
 * The closed dimension vocabulary.
 *
 * Closed on purpose: the spec's rule is that every dimension the gateway offers is one it
 * must be able to measure, hold, and diagnose. An unknown dimension name is rejected at
 * write time rather than ignored.
 */
export type DimensionName = "p95_ms" | "cost_per_1k_tokens_usd" | "success_rate";

export const DIMENSION_NAMES: readonly DimensionName[] = [
  "p95_ms",
  "cost_per_1k_tokens_usd",
  "success_rate",
];

/**
 * Which way a dimension is good.
 *
 * `p95_ms` and `cost_per_1k_tokens_usd` are ceilings — lower is better, and the stated
 * value is a maximum. `success_rate` is a floor — higher is better, and the stated value
 * is a minimum. Everything that compares an observation against a target goes through
 * `holdsTarget` below so the asymmetry is expressed once.
 */
export function isCeiling(dimension: DimensionName): boolean {
  return dimension !== "success_rate";
}

/** True when `observed` satisfies `target` for this dimension. */
export function holdsTarget(
  dimension: DimensionName,
  observed: number,
  target: number,
): boolean {
  return isCeiling(dimension) ? observed <= target : observed >= target;
}

/** An entry in `allowed_models`: a bare model, optionally pinned to one host. */
export interface AllowedModel {
  readonly model: string;
  /** `null` means any host the gateway can reach for that model. */
  readonly host: string | null;
}

/** One named class of a customer's traffic, and the target stated over it. */
export interface Workload {
  readonly name: string;
  /** Required and non-empty: the customer's explicit blast radius. */
  readonly allowedModels: readonly AllowedModel[];
  /** Stated dimensions and their values. Zero or more, closed vocabulary. */
  readonly dimensions: Readonly<Partial<Record<DimensionName, number>>>;
  /** The order dimensions were declared in; the default priority is its reverse. */
  readonly declarationOrder: readonly DimensionName[];
  /** The quantity to minimize, or `none` (hold the cheapest satisfying mix). */
  readonly objective: DimensionName | "none";
  /** Highest priority first. The last entry is the ceiling that yields first. */
  readonly priority: readonly DimensionName[];
  /** At most one dimension that fails the request rather than being breached. */
  readonly hard: DimensionName | null;
}

/**
 * The single versioned document that is the only source of truth for a customer's
 * targets. A management API and a dashboard are two views onto it.
 */
export interface TargetDocument {
  /** Bumped by the store on every accepted write; supplied by a writer to claim a CAS. */
  readonly version: number;
  /** Always contains a workload named `default`. */
  readonly workloads: Readonly<Record<string, Workload>>;
  /** Where `unmet` transitions are POSTed, or `null` for no notification. */
  readonly notifyUrl: string | null;
}

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

/**
 * Provider capacity the customer has already paid for.
 *
 * A reservation is a fact about the customer's contract with a provider, not a statement of
 * what they want from us, which is why it is its own versioned resource rather than a field
 * in the target document: a term expiring would otherwise change what a target means with no
 * customer write, and the target document holds only what the customer authored.
 *
 * `addressingModel` is the whole point of the record. Reserved capacity is not reached by
 * asking for the foundation model — it is reached by naming the provisioned resource (a
 * provisioned model ARN on Bedrock, a deployment name on Azure), and a call site that passes
 * the plain model identifier pays on-demand rates against capacity already bought.
 */
export interface Reservation {
  /** Customer-chosen, unique within their document, and echoed on connector usage reports. */
  readonly id: string;
  readonly host: string;
  /** The foundation model the reservation serves; matched against a provider's `model`. */
  readonly model: string;
  readonly region: string;
  /** The size in whatever unit that host sells. Bedrock model units, Azure PTUs. */
  readonly sizeUnits: number;
  readonly unit: string;
  readonly termStartMs: number;
  readonly termEndMs: number;
  /**
   * What a thousand tokens actually cost under this term.
   *
   * This is the first customer-specific value in the routing vocabulary: the capability
   * catalogue's `cost_per_1k_tokens_usd` floor is keyed globally and cannot express it.
   */
  readonly effectiveRatePer1kTokensUsd: number;
  /** The host-specific string that addresses the reserved capacity. */
  readonly addressingModel: string;
}

/** The versioned document holding every reservation a customer has declared. */
export interface ReservationDocument {
  readonly version: number;
  readonly reservations: readonly Reservation[];
}

/** True when `nowMs` falls inside the term. Half-open at the end, so a term is not double-counted. */
export function reservationIsLive(reservation: Reservation, nowMs: number): boolean {
  return nowMs >= reservation.termStartMs && nowMs < reservation.termEndMs;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/** The distinct value a dimension carries below the sample floor. */
export const INSUFFICIENT_DATA = "insufficient_data";

/**
 * A measured dimension value, or the explicit absence of one.
 *
 * `insufficient_data` is a value rather than a `null` because the spec forbids reporting
 * a percentile computed from a handful of requests, and a `null` invites a caller to
 * treat it as zero.
 */
export type Measured = number | typeof INSUFFICIENT_DATA;

/** One completed request, as measurement sees it. */
export interface RequestOutcome {
  readonly workload: string;
  readonly providerId: string;
  /** Provider-attributable latency: time to last byte from the upstream. */
  readonly latencyMs: number;
  /** The unit rate for what was actually served. */
  readonly costPer1kTokensUsd: number;
  /**
   * Whether the caller got a usable response after all internal retries and failovers.
   * A re-routed 429 or 5xx is a success — absorbing it is the product being sold.
   */
  readonly success: boolean;
  /**
   * Malformed customer requests are excluded from the denominator entirely; they are not
   * provider risk. Such an outcome is dropped rather than counted either way.
   */
  readonly malformed: boolean;
  readonly atMs: number;
}

/**
 * What one process observed for one (workload, provider) over one closed window.
 *
 * Written to the store at window close, best-effort, and merged across processes at
 * evaluation. `latenciesMs` is carried in full rather than pre-reduced to a percentile
 * because a percentile of percentiles is not a percentile; the window is bounded at 200
 * requests, so the array is small by construction.
 */
export interface WindowSummary {
  readonly workload: string;
  readonly providerId: string;
  /** Identifies the writing process, so a dead process's rows age out by timestamp. */
  readonly processId: string;
  readonly openedAtMs: number;
  readonly closedAtMs: number;
  readonly latenciesMs: readonly number[];
  readonly successCount: number;
  readonly requestCount: number;
  /** Sum of per-request unit rates; divided by `requestCount` to get the mix's rate. */
  readonly costPer1kTokensUsdSum: number;
}

/** What routing knows about one provider at one moment, over the merged window. */
export interface ProviderObservation {
  readonly providerId: string;
  readonly p95Ms: Measured;
  readonly costPer1kTokensUsd: Measured;
  readonly successRate: Measured;
  /** How long the merged window spans, for the report. */
  readonly windowSpanMs: number;
  /** Merged across processes: the sample floor is workload-wide, not per-process. */
  readonly sampleCount: number;
}

/**
 * A snapshot of what routing knows at one moment.
 *
 * `chooseProvider` takes this as an argument rather than reading it, which is what keeps
 * the routing seam pure.
 */
export interface ProviderState {
  readonly providers: readonly Provider[];
  /** Keyed by provider id. A provider with no entry is `insufficient_data` throughout. */
  readonly observations: Readonly<Record<string, ProviderObservation>>;
  /** The workload whose target is in force, or `null` for no target at all. */
  readonly workload: Workload | null;
  /**
   * Reservations whose term covers this instant, already resolved by the caller.
   *
   * *Live* is the load-bearing word. Term liveness is a question about a clock, and
   * `chooseProvider` reads no clock — so the snapshot's builder answers it, exactly as it
   * already answers "what has been measured". A reservation that has expired is simply
   * absent here, which is what makes the routing preference expire without the routing
   * function knowing what time it is.
   *
   * Absent or empty means the customer has declared none, and every reservation branch
   * downstream is inert.
   */
  readonly liveReservations?: readonly Reservation[];
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Why a candidate provider was not chosen.
 *
 * The spec requires both infeasibility reports to name why each candidate was rejected,
 * and a reason reconstructed from logs after the fact is not trustworthy
 * (docs/adr/0001-declaration-time-vs-observed-infeasibility.md).
 */
export interface RejectionReason {
  readonly providerId: string;
  /** The dimension that disqualified it, or `null` when it was not a dimension. */
  readonly dimension: DimensionName | null;
  readonly observed: Measured | null;
  readonly target: number | null;
  readonly reason: string;
}

/**
 * The routing seam's return value: the choice, plus why it is the choice.
 *
 * Infeasibility is a return value, never an exception. `provider` is `null` only when a
 * hard dimension could not be held, which the spec says must fail the request rather than
 * be breached; `failedHard` names that dimension so the caller does not have to guess why.
 */
export interface RoutingDecision {
  readonly provider: Provider | null;
  /** The dimension that bound the decision, or `null` when nothing bound it. */
  readonly boundBy: DimensionName | null;
  /** The lowest-priority ceiling that had to yield, when no mix satisfied every one. */
  readonly yielded: DimensionName | null;
  /** Set when a hard dimension forced the request to fail instead of being breached. */
  readonly failedHard: DimensionName | null;
  readonly rejected: readonly RejectionReason[];
}

// ---------------------------------------------------------------------------
// Capability floors and declaration-time feasibility
// ---------------------------------------------------------------------------

/**
 * Where a capability floor came from. No provider publishes a latency floor, so floors
 * are sourced by measurement and carry their provenance and age into any rejection that
 * rests on them (#12, docs/adr/0003-*).
 */
export type Provenance = "vendor_published" | "measured" | "estimated";

/** The best a `(model, host, region, service_tier)` can plausibly do on one dimension. */
export interface CapabilityFloor {
  readonly model: string;
  readonly host: string;
  readonly region: string;
  readonly serviceTier: string;
  readonly providerId: string;
  readonly dimension: DimensionName;
  /** The best plausibly achievable value: a minimum for ceilings, a maximum for floors. */
  readonly value: number;
  /** The floor's own variance. A target is rejected only when it fails by more. */
  readonly variance: number;
  readonly provenance: Provenance;
  readonly observedAtMs: number;
  /** Past `observedAtMs + ttlMs` the floor is stale and cannot support a rejection. */
  readonly ttlMs: number;
  /** Any workload shape the floor assumes, disclosed in a rejection that uses it. */
  readonly assumption?: string;
}

/** A single dimension's declaration-time rejection, with the basis it rests on. */
export interface InfeasibilityReport {
  readonly workload: string;
  readonly dimension: DimensionName;
  readonly requested: number;
  readonly bestAchievable: number;
  readonly providerId: string;
  readonly model: string;
  readonly host: string;
  readonly floorProvenance: Provenance;
  readonly floorAgeMs: number;
  readonly assumption: string | null;
}

/**
 * The result of the declaration-time check.
 *
 * `abstained` is a distinct outcome, not a flavor of `feasible`: when every candidate
 * floor is stale the write is accepted, and the spec requires that abstention to be
 * observable rather than silent.
 */
export type FeasibilityResult =
  | { readonly status: "feasible" }
  | { readonly status: "abstained"; readonly staleDimensions: readonly DimensionName[]; readonly detail: string }
  | { readonly status: "infeasible"; readonly reports: readonly InfeasibilityReport[] };

// ---------------------------------------------------------------------------
// `unmet`
// ---------------------------------------------------------------------------

/** The diagnosis carried by the `unmet` state: what failed, by how much, over what. */
export interface UnmetReport {
  readonly dimension: DimensionName;
  readonly target: number;
  readonly observed: Measured;
  readonly windowSpanMs: number;
  readonly windowRequestCount: number;
  readonly rejections: readonly RejectionReason[];
}

/**
 * The two-window state machine's persisted state for one workload.
 *
 * Entry and exit are deliberately symmetric — two consecutive missed windows in, two
 * consecutive held windows out. The symmetry is anti-flap; a faster exit is not an
 * improvement.
 */
export interface UnmetState {
  readonly workload: string;
  readonly unmet: boolean;
  readonly since: number | null;
  readonly report: UnmetReport | null;
  /** Consecutive full windows in which the target was missed. */
  readonly missedStreak: number;
  /** Consecutive full windows in which it was held. */
  readonly heldStreak: number;
  /** Window-close time of the last window folded in, for staleness on restart. */
  readonly lastWindowAtMs: number | null;
}
