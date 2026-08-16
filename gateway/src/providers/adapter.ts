import type {
  GatewayRequest,
  GatewayResponse,
  UpstreamRequest,
  UpstreamResponse,
} from "../types.js";

/**
 * A pure translation pair between the gateway's shapes and one upstream's dialect.
 *
 * No I/O and no framework types: the adapter *describes* the upstream call, and
 * `server.ts` performs it. This is the contract a reimplemented data plane would have to
 * honor, so it stays expressible as a Rust trait or Go interface.
 *
 * Streaming is deferred here — the tracer buffers whole bodies. When it lands, this
 * contract gains a chunk-transform function rather than a stream object, which is why
 * nothing above should assume a body is a complete document.
 */
export interface ProviderAdapter {
  readonly id: string;
  toUpstream(req: GatewayRequest): UpstreamRequest;
  fromUpstream(res: UpstreamResponse): GatewayResponse;
  /**
   * Per-request cost estimate.
   *
   * Present from M1 (a constant for the passthrough adapter) because target-state
   * routing and reservation-aware routing both consume it, and retrofitting it later
   * would touch every adapter.
   */
  costOf(req: GatewayRequest, res: GatewayResponse): number;
}
