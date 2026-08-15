/**
 * The configuration surface, read once at startup.
 *
 * M1's surface is two environment variables and nothing else. Reading them here rather
 * than at each use keeps `routing/` and `providers/` free of ambient input, which is the
 * property the portable-data-path claim rests on.
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
}

export class ConfigError extends Error {}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
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

  return {
    upstreamBaseUrl: stripTrailingSlash(upstream.trim()),
    port,
    forceRouterError: env["FORCE_ROUTER_ERROR"] === "1",
  };
}
