import type { ProviderAdapter } from "./adapter.js";
import type {
  GatewayRequest,
  GatewayResponse,
  UpstreamRequest,
  UpstreamResponse,
} from "../types.js";

/**
 * Headers that describe the *connection* the gateway received, not the request it
 * forwards. Passing them upstream would describe a hop that no longer exists.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

function withoutHopByHop(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase())) kept[name] = value;
  }
  return kept;
}

/**
 * M1's sole adapter: it forwards the request unchanged and returns the response
 * unchanged, translating nothing.
 *
 * It exists to prove the seam rather than to speak a dialect. A real provider adapter
 * replaces the bodies of `toUpstream` and `fromUpstream`; nothing outside this file
 * changes when it does.
 */
export const passthroughAdapter: ProviderAdapter = {
  id: "passthrough",

  toUpstream(req: GatewayRequest): UpstreamRequest {
    return {
      method: req.method,
      path: req.path,
      headers: withoutHopByHop(req.headers),
      body: req.body,
    };
  },

  fromUpstream(res: UpstreamResponse): GatewayResponse {
    return {
      status: res.status,
      headers: withoutHopByHop(res.headers),
      body: res.body,
    };
  },

  /**
   * Zero, and deliberately not a guess. Cost per request is a function of token counts
   * this adapter does not read; M2 computes it against the capability catalogue. A
   * fabricated non-zero number here would be indistinguishable from a measured one.
   */
  costOf(_req: GatewayRequest, _res: GatewayResponse): number {
    return 0;
  },
};
