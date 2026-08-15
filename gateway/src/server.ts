import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig, type Config } from "./config.js";
import { chooseProvider } from "./routing/chooseProvider.js";
import { passthroughAdapter } from "./providers/passthrough.js";
import type { GatewayRequest, Provider, ProviderState } from "./types.js";

/** The one inbound endpoint this plan exposes. */
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

/**
 * Set when a request was forwarded despite the routing seam failing.
 *
 * It is on the response rather than only in a log because fail-open is a *claim* the
 * product spec makes to a customer, and a claim they cannot observe is not one they can
 * hold us to.
 */
const FAIL_OPEN_HEADER = "x-gateway-failopen";

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normalizeHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

/**
 * Decide where the request goes, and never let that decision be the reason a request
 * fails.
 *
 * This is the fail-open boundary the spec requires: when routing throws, the request
 * still goes to the configured upstream. The gateway is allowed to lose its opinion; it
 * is not allowed to lose the request.
 */
function routeWithFailOpen(
  request: GatewayRequest,
  state: ProviderState,
  config: Config,
): { provider: Provider; failedOpen: boolean } {
  const defaultProvider: Provider = {
    id: "default",
    baseUrl: config.upstreamBaseUrl,
  };

  try {
    if (config.forceRouterError) {
      throw new Error("FORCE_ROUTER_ERROR=1: routing seam failed by request");
    }
    return { provider: chooseProvider(request, state).provider, failedOpen: false };
  } catch (error) {
    console.error("[gateway] routing failed, forwarding to default upstream:", error);
    return { provider: defaultProvider, failedOpen: true };
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, config: Config): Promise<void> {
  if (req.method !== "POST" || (req.url ?? "") !== CHAT_COMPLETIONS_PATH) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found", type: "gateway_error" } }));
    return;
  }

  const request: GatewayRequest = {
    method: req.method,
    path: req.url ?? CHAT_COMPLETIONS_PATH,
    headers: normalizeHeaders(req),
    body: await readBody(req),
  };

  const state: ProviderState = {
    providers: [{ id: "passthrough", baseUrl: config.upstreamBaseUrl }],
  };

  const { provider, failedOpen } = routeWithFailOpen(request, state, config);

  // The adapter describes the call; the data path performs it. Keeping `fetch` here is
  // what keeps adapters pure and re-expressible in another language.
  const upstreamRequest = passthroughAdapter.toUpstream(request);

  try {
    const upstream = await fetch(`${provider.baseUrl}${upstreamRequest.path}`, {
      method: upstreamRequest.method,
      headers: upstreamRequest.headers,
      body: upstreamRequest.body,
    });

    const upstreamHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, name) => {
      upstreamHeaders[name] = value;
    });

    const response = passthroughAdapter.fromUpstream({
      status: upstream.status,
      headers: upstreamHeaders,
      body: await upstream.text(),
    });

    const headers: Record<string, string> = { ...response.headers };
    if (failedOpen) headers[FAIL_OPEN_HEADER] = "true";

    res.writeHead(response.status, headers);
    res.end(response.body);
  } catch (error) {
    // The upstream itself is unreachable. There is nothing to fail open *to*: the
    // customer's own configured provider is what we were already trying.
    console.error("[gateway] upstream request failed:", error);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (failedOpen) headers[FAIL_OPEN_HEADER] = "true";
    res.writeHead(502, headers);
    res.end(
      JSON.stringify({ error: { message: "upstream unreachable", type: "gateway_error" } }),
    );
  }
}

export function createGateway(config: Config): Server {
  return createHttpServer((req, res) => {
    handle(req, res, config).catch((error: unknown) => {
      console.error("[gateway] unhandled request failure:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: { message: "internal error", type: "gateway_error" } }));
    });
  });
}

// Entry point. Guarded so tests can import `createGateway` without starting a listener.
const invokedDirectly =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const config = loadConfig();
  createGateway(config).listen(config.port, () => {
    console.log(
      `[gateway] listening on http://localhost:${config.port} -> ${config.upstreamBaseUrl}` +
        (config.forceRouterError ? " (FORCE_ROUTER_ERROR=1)" : ""),
    );
  });
}
