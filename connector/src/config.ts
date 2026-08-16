import type { ConnectorOptions } from "./types.js";

/**
 * The only module that reads the environment, mirroring the gateway's rule.
 *
 * Keeping it in one place is what lets every other module take its configuration as an
 * argument, which is why the failover, buffering and backoff rules can be tested without
 * setting a single variable.
 */
export class ConfigError extends Error {}

export function loadConnectorOptions(env: Readonly<Record<string, string | undefined>>): ConnectorOptions {
  const gatewayUrl = required(env, "GATEWAY_URL").replace(/\/+$/, "");
  const fallbackBaseUrl = required(env, "CONNECTOR_FALLBACK_BASE_URL").replace(/\/+$/, "");
  const providerApiKey = env["PROVIDER_API_KEY"];

  return {
    gatewayUrl,
    connectorToken: required(env, "GATEWAY_CONNECTOR_TOKEN"),
    workload: env["CONNECTOR_WORKLOAD"] ?? "default",
    fallbackBaseUrl,
    fallbackModel: required(env, "CONNECTOR_FALLBACK_MODEL"),
    // Spread conditionally rather than assigning `undefined`: `exactOptionalPropertyTypes`
    // treats an explicit `undefined` as a distinct value from an absent key.
    ...(providerApiKey === undefined ? {} : { providerApiKey }),
  };
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new ConfigError(`${name} is required`);
  }
  return value;
}
