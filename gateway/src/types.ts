/**
 * Plain-data shapes shared across the gateway.
 *
 * Nothing here imports a server or framework type. The design doc's dependency rule
 * (docs/design-docs/gateway-design.md) rests on that: `routing/`, `targets/`, and
 * `providers/` speak only in these shapes, so a future Rust or Go data plane can
 * re-express them without inheriting Node's HTTP types.
 */

/** A provider the gateway can route to. M1 knows exactly one. */
export interface Provider {
  readonly id: string;
  /** Base URL of the upstream, without a trailing slash. */
  readonly baseUrl: string;
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

/**
 * A snapshot of what routing knows about providers at one moment.
 *
 * `chooseProvider` takes this as an argument rather than reading it, which is what keeps
 * the routing seam pure. M2 fills it out with measurement windows; M1 carries only the
 * candidate list.
 */
export interface ProviderState {
  readonly providers: readonly Provider[];
}

/**
 * Why a candidate provider was not chosen.
 *
 * M1 never rejects anything — there is one candidate. The shape exists from the start
 * because the spec requires both infeasibility reports to name why each candidate was
 * rejected, and a reason reconstructed from logs after the fact is not trustworthy
 * (see docs/adr/0001-declaration-time-vs-observed-infeasibility.md).
 */
export interface RejectionReason {
  readonly providerId: string;
  readonly reason: string;
}

/** The routing seam's return value: the choice, plus why it is the choice. */
export interface RoutingDecision {
  readonly provider: Provider;
  /** The dimension that bound the decision, or `null` when nothing bound it. */
  readonly boundBy: string | null;
  readonly rejected: readonly RejectionReason[];
}
