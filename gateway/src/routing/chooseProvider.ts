import type { GatewayRequest, ProviderState, RoutingDecision } from "../types.js";

/**
 * The routing seam.
 *
 * Pure over a state snapshot: it performs no I/O, reads no clock, and touches no
 * configuration. That is what lets M2 replace this body with target-state logic without
 * touching the forwarding path, and what lets the same function later compute the ranked
 * list pushed to the connector rather than a per-request choice
 * (docs/adr/0006-routing-authority-stays-gateway-side.md).
 *
 * M1 returns the sole upstream. It throws when there is none rather than inventing a
 * fallback, because the fail-open wrapper in `server.ts` — not this function — owns what
 * happens when routing cannot decide.
 */
export function chooseProvider(
  _request: GatewayRequest,
  state: ProviderState,
): RoutingDecision {
  const provider = state.providers[0];
  if (provider === undefined) {
    throw new Error("no provider available: ProviderState carries no candidates");
  }

  return {
    provider,
    boundBy: null,
    rejected: [],
  };
}
