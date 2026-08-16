import type { Provider } from "./types.js";

/**
 * The configuration surface, read once at startup.
 *
 * This is the only module that reads the environment; everything else receives parsed
 * config as arguments. That is what keeps `routing/`, `targets/`, and `providers/` free of
 * ambient input, which is the property the portable-data-path claim rests on.
 *
 * M2 adds the store path, the notification secret, the window shape, and the provider
 * catalogue. The notification *secret* lives here rather than in the target store on
 * purpose (docs/adr/0002-durable-target-store-with-cross-process-concurrency.md): the
 * store is a customer-writable document, and a signing key must not be reachable through
 * a management API that writes it.
 */
export interface Config {
  /** Where the passthrough provider forwards to, without a trailing slash. */
  readonly upstreamBaseUrl: string;
  /** Port the gateway listens on. */
  readonly port: number;
  /**
   * Makes the routing seam throw, so the fail-open path is demonstrable without
   * breaking anything. A test affordance, stated in the ExecPlan.
   */
  readonly forceRouterError: boolean;
  /** SQLite file backing the target document, `unmet` state, and window summaries. */
  readonly storePath: string;
  /** Per-customer secret the `unmet` notification is signed with, or `null` for none. */
  readonly notifySecret: string | null;
  /**
   * How often each process re-reads the document version.
   *
   * The spec's boundary is that a target change takes effect within approximately five
   * seconds of being written, not instantly: a `200` on `PUT /v1/targets` means
   * *committed*, not *in force in every process*.
   */
  readonly pollMs: number;
  /** Rolling window shape: at least this long and this many requests before it closes. */
  readonly windowMs: number;
  readonly windowMinRequests: number;
  /** Below this many merged samples a dimension reports `insufficient_data`. */
  readonly sampleFloor: number;
  /** How long the `unmet` notification is retried before it is dropped. */
  readonly notifyRetryMs: number;
  /**
   * The providers routing may choose between.
   *
   * Defaults to the single passthrough upstream, which is exactly M1's behavior: a
   * gateway configured the M1 way keeps routing the M1 way.
   */
  readonly providers: readonly Provider[];
  /**
   * The bearer token that guards connector minting, or `null` when there is none.
   *
   * `null` does not mean "open": it means the minting endpoint is absent entirely. An
   * unguarded endpoint that hands out customer credentials is worse than a missing one, and
   * an operator who never set the variable has not decided to run without authentication.
   */
  readonly adminToken: string | null;
  /**
   * How long a list change is allowed to settle before it is pushed to connectors.
   *
   * A target write can move several workloads at once, and each move recomputes a list.
   * Pushing every intermediate one would spend the connector's reconnects on versions that
   * were already superseded when they were sent.
   */
  readonly pushDebounceMs: number;
  /**
   * Refuses the SSE stream, so connectors fall back to polling.
   *
   * A test affordance: the degraded mode is the one that matters most and the one hardest
   * to reach on purpose, and demonstrating it should not require a firewall rule.
   */
  readonly sseDisabled: boolean;
}

export class ConfigError extends Error {}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigError(`${name} is not a positive integer: ${raw}`);
  }
  return value;
}

/**
 * Parse the provider catalogue from JSON.
 *
 * Providers carry `model` and `host` because a workload's `allowed_models` is matched
 * against them, and a bare model entry means "any host". The same model on different
 * hosts measured an 86% spread in p50 latency on a single day (issue #11), so the host is
 * part of a provider's identity rather than a label on it.
 */
function parseProviders(raw: string, upstreamBaseUrl: string): readonly Provider[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`GATEWAY_PROVIDERS is not valid JSON: ${String(error)}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ConfigError("GATEWAY_PROVIDERS must be a non-empty JSON array");
  }

  return parsed.map((entry, index): Provider => {
    if (typeof entry !== "object" || entry === null) {
      throw new ConfigError(`GATEWAY_PROVIDERS[${index}] is not an object`);
    }
    const record = entry as Record<string, unknown>;
    const requireString = (field: string, fallback?: string): string => {
      const value = record[field];
      if (value === undefined && fallback !== undefined) return fallback;
      if (typeof value !== "string" || value.trim() === "") {
        throw new ConfigError(`GATEWAY_PROVIDERS[${index}].${field} must be a non-empty string`);
      }
      return value;
    };

    return {
      id: requireString("id"),
      baseUrl: stripTrailingSlash(requireString("baseUrl", upstreamBaseUrl)),
      model: requireString("model"),
      host: requireString("host"),
      region: requireString("region", "local"),
      serviceTier: requireString("serviceTier", "standard"),
    };
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const upstream = env["UPSTREAM_BASE_URL"];
  if (upstream === undefined || upstream.trim() === "") {
    throw new ConfigError("UPSTREAM_BASE_URL is required");
  }

  try {
    new URL(upstream);
  } catch {
    throw new ConfigError(`UPSTREAM_BASE_URL is not a valid URL: ${upstream}`);
  }

  const rawPort = env["PORT"] ?? "8080";
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT is not a valid port number: ${rawPort}`);
  }

  const upstreamBaseUrl = stripTrailingSlash(upstream.trim());
  const rawProviders = env["GATEWAY_PROVIDERS"];
  const providers =
    rawProviders === undefined || rawProviders.trim() === ""
      ? ([
          {
            id: "passthrough",
            baseUrl: upstreamBaseUrl,
            model: "passthrough",
            host: "upstream",
            region: "local",
            serviceTier: "standard",
          },
        ] as const)
      : parseProviders(rawProviders, upstreamBaseUrl);

  const notifySecret = env["GATEWAY_NOTIFY_SECRET"];
  const adminToken = env["GATEWAY_ADMIN_TOKEN"];

  return {
    upstreamBaseUrl,
    port,
    forceRouterError: env["FORCE_ROUTER_ERROR"] === "1",
    storePath: env["GATEWAY_STORE_PATH"] ?? "gateway-store.sqlite",
    notifySecret: notifySecret === undefined || notifySecret === "" ? null : notifySecret,
    pollMs: positiveInteger(env["GATEWAY_POLL_MS"], 5_000, "GATEWAY_POLL_MS"),
    windowMs: positiveInteger(env["GATEWAY_WINDOW_MS"], 300_000, "GATEWAY_WINDOW_MS"),
    windowMinRequests: positiveInteger(
      env["GATEWAY_WINDOW_MIN_REQUESTS"],
      200,
      "GATEWAY_WINDOW_MIN_REQUESTS",
    ),
    sampleFloor: positiveInteger(env["GATEWAY_SAMPLE_FLOOR"], 20, "GATEWAY_SAMPLE_FLOOR"),
    notifyRetryMs: positiveInteger(env["GATEWAY_NOTIFY_RETRY_MS"], 900_000, "GATEWAY_NOTIFY_RETRY_MS"),
    providers,
    adminToken: adminToken === undefined || adminToken.trim() === "" ? null : adminToken,
    pushDebounceMs: positiveInteger(
      env["GATEWAY_PUSH_DEBOUNCE_MS"],
      1_000,
      "GATEWAY_PUSH_DEBOUNCE_MS",
    ),
    sseDisabled: env["GATEWAY_SSE_DISABLED"] === "1",
  };
}
