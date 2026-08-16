import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig, type Config } from "./config.js";
import { ControlPlane, isControlPlanePath } from "./controlplane/api.js";
import { handleManagementRequest, isManagementPath } from "./management/api.js";
import { UnmetNotifier } from "./management/notify.js";
import { chooseProvider } from "./routing/chooseProvider.js";
import { classifyStatus } from "./routing/stats.js";
import { TargetService } from "./targets/service.js";
import { passthroughAdapter } from "./providers/passthrough.js";
import type { GatewayRequest, Provider, RoutingDecision } from "./types.js";

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

/** Names the workload a request belongs to. A header, never a path segment: path-based
 * routing would break the base-URL substitution that behavior 2 depends on. */
const WORKLOAD_HEADER = "x-gateway-workload";

/** Carries the bound dimension on responses served while the workload is `unmet`. */
const TARGET_UNMET_HEADER = "x-gateway-target-unmet";

/** What the simulated providers report their unit rate as. M2 has no token accounting. */
const SIM_COST_HEADER = "x-sim-cost-per-1k-usd";

const DEFAULT_WORKLOAD = "default";

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

interface RouteOutcome {
  readonly provider: Provider;
  readonly failedOpen: boolean;
  readonly decision: RoutingDecision | null;
}

/**
 * Decide where the request goes, and never let that decision be the reason a request
 * fails.
 *
 * This is the fail-open boundary the spec requires: when routing throws, the request
 * still goes to the configured upstream. The gateway is allowed to lose its opinion; it
 * is not allowed to lose the request.
 *
 * A hard-dimension failure is deliberately *not* handled here. That is not the routing
 * seam breaking — it is the routing seam working, on a customer's explicit instruction to
 * fail the request rather than breach the dimension. Failing open through it would
 * silently overrule them.
 */
function routeWithFailOpen(
  request: GatewayRequest,
  service: TargetService | null,
  workloadName: string,
  config: Config,
): RouteOutcome | { readonly failedHard: string; readonly decision: RoutingDecision } {
  const defaultProvider: Provider = {
    id: "default",
    baseUrl: config.upstreamBaseUrl,
    model: "passthrough",
    host: "upstream",
    region: "local",
    serviceTier: "standard",
  };

  try {
    if (config.forceRouterError) {
      throw new Error("FORCE_ROUTER_ERROR=1: routing seam failed by request");
    }

    const state =
      service === null
        ? { providers: config.providers, observations: {}, workload: null }
        : service.providerState(workloadName);

    const decision = chooseProvider(request, state);
    if (decision.provider === null) {
      return { failedHard: decision.failedHard ?? "unknown", decision };
    }
    return { provider: decision.provider, failedOpen: false, decision };
  } catch (error) {
    console.error("[gateway] routing failed, forwarding to default upstream:", error);
    return { provider: defaultProvider, failedOpen: true, decision: null };
  }
}

async function handleDataPath(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  service: TargetService | null,
): Promise<void> {
  const headers = normalizeHeaders(req);
  const workloadName = headers[WORKLOAD_HEADER] ?? DEFAULT_WORKLOAD;

  const request: GatewayRequest = {
    method: req.method ?? "POST",
    path: req.url ?? CHAT_COMPLETIONS_PATH,
    headers,
    body: await readBody(req),
  };

  const routed = routeWithFailOpen(request, service, workloadName, config);

  if ("failedHard" in routed) {
    // The customer marked this dimension hard, meaning breach it and you have done worse
    // than fail. So we fail, and we say which dimension and why every candidate was
    // rejected — a refusal without a diagnosis is not acceptable here.
    res.writeHead(503, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: `hard dimension ${routed.failedHard} could not be held; failing rather than breaching it`,
          type: "target_unsatisfiable",
          dimension: routed.failedHard,
          rejected: routed.decision.rejected,
        },
      }),
    );
    return;
  }

  const { provider, failedOpen } = routed;
  const unmetDimension = service?.unmetDimension(workloadName) ?? null;

  // The adapter describes the call; the data path performs it. Keeping `fetch` here is
  // what keeps adapters pure and re-expressible in another language.
  const upstreamRequest = passthroughAdapter.toUpstream(request);
  const startedAtMs = Date.now();

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

    // Provider-attributable latency: time to last byte from the upstream. Only this
    // portion is movable by a routing decision, so only this portion is measured.
    const latencyMs = Date.now() - startedAtMs;
    const { success, malformed } = classifyStatus(upstream.status);
    service?.record({
      workload: workloadName,
      providerId: provider.id,
      latencyMs,
      costPer1kTokensUsd: Number(upstreamHeaders[SIM_COST_HEADER] ?? "0"),
      success,
      malformed,
      atMs: startedAtMs,
    });

    const outHeaders: Record<string, string> = { ...response.headers };
    if (failedOpen) outHeaders[FAIL_OPEN_HEADER] = "true";
    if (unmetDimension !== null) outHeaders[TARGET_UNMET_HEADER] = unmetDimension;

    res.writeHead(response.status, outHeaders);
    res.end(response.body);
  } catch (error) {
    // The upstream itself is unreachable. There is nothing to fail open *to*: the
    // customer's own configured provider is what we were already trying.
    console.error("[gateway] upstream request failed:", error);
    service?.record({
      workload: workloadName,
      providerId: provider.id,
      latencyMs: Date.now() - startedAtMs,
      costPer1kTokensUsd: 0,
      success: false,
      malformed: false,
      atMs: startedAtMs,
    });

    const outHeaders: Record<string, string> = { "content-type": "application/json" };
    if (failedOpen) outHeaders[FAIL_OPEN_HEADER] = "true";
    if (unmetDimension !== null) outHeaders[TARGET_UNMET_HEADER] = unmetDimension;
    res.writeHead(502, outHeaders);
    res.end(
      JSON.stringify({ error: { message: "upstream unreachable", type: "gateway_error" } }),
    );
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  config: Config,
  service: TargetService | null,
  controlPlane: ControlPlane | null,
): Promise<void> {
  const path = (req.url ?? "").split("?")[0] ?? "";

  // Ahead of everything, and ahead of the data path in particular: these are the paths a
  // connector uses to find out where to send traffic, and a gateway too busy to answer them
  // is a gateway whose customers are routing on a stale list.
  if (controlPlane !== null && isControlPlanePath(path)) {
    controlPlane.handle(req, res, path, await readBody(req));
    return;
  }

  if (service !== null && isManagementPath(path)) {
    const response = handleManagementRequest(
      { method: req.method ?? "GET", path, body: await readBody(req) },
      service,
    );
    res.writeHead(response.status, response.headers);
    res.end(response.body);
    return;
  }

  if (req.method !== "POST" || path !== CHAT_COMPLETIONS_PATH) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found", type: "gateway_error" } }));
    return;
  }

  await handleDataPath(req, res, config, service);
}

export interface GatewayDeps {
  /**
   * The target apparatus. Pass `null` for the M1 shape — a pure forwarding tracer with no
   * store, no targets, and no measurement — which is what the fail-open tests exercise.
   */
  readonly service?: TargetService | null;
}

export function createGateway(config: Config, deps: GatewayDeps = {}): Server {
  const service =
    deps.service !== undefined
      ? deps.service
      : TargetService.start(config, {
          onTransition: (transition, state, document) => {
            const notifier = new UnmetNotifier({ retryMs: config.notifyRetryMs });
            void notifier
              .deliver(document.notifyUrl, config.notifySecret, {
                event: transition === "entered" ? "unmet_entered" : "unmet_left",
                workload: state.workload,
                state,
                atMs: Date.now(),
              })
              .then((outcome) => {
                if (!outcome.delivered && outcome.droppedReason !== null) {
                  // Dropping is safe and intended: the status resource is the record.
                  console.warn(
                    `[gateway] unmet notification dropped for ${state.workload}: ${outcome.droppedReason}`,
                  );
                }
              });
          },
        });

  // Without a service there is no store, so there is no token to resolve and no list to
  // compute; the M1 shape simply has no control plane.
  const controlPlane = service === null ? null : new ControlPlane(config, service);

  const server = createHttpServer((req, res) => {
    handle(req, res, config, service, controlPlane).catch((error: unknown) => {
      console.error("[gateway] unhandled request failure:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: { message: "internal error", type: "gateway_error" } }));
    });
  });

  // The control plane must not outlive the socket it was created for.
  if (deps.service === undefined && service !== null) {
    server.on("close", () => service.stop());
  }
  // Unconditional, unlike the service above: the streams belong to this server whoever owns
  // the service, and an SSE response left open holds a socket and a heartbeat timer that
  // keep the process alive and keep writing into a server that has gone.
  if (controlPlane !== null) {
    server.on("close", () => controlPlane.close());
  }
  return server;
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
