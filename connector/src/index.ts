import { createCaller } from "./call.js";
import { createChannel } from "./channel.js";
import { createReporter } from "./report.js";
import type { Caller } from "./call.js";
import type { Channel } from "./channel.js";
import type { Reporter } from "./report.js";
import type { ChannelMode, ConnectorOptions, RankedList, RankedProvider } from "./types.js";

/**
 * Wiring: the three pieces, joined.
 *
 * They are kept separate modules rather than one because they fail independently and must
 * be allowed to. The channel going down must not stop calls; the reporter going down must
 * not stop calls; only the caller is in the customer's request path at all.
 */
export interface Connector {
  /** The single function the customer's application calls. */
  readonly call: Caller;
  /** Whether directives are arriving pushed or polled — the documented degraded mode. */
  mode(): ChannelMode;
  /** The list currently in force for a workload, for a sample app or a health endpoint. */
  currentList(workload?: string): RankedList | null;
  close(): void;
}

export function createConnector(options: ConnectorOptions): Connector {
  const channel: Channel = createChannel({
    gatewayUrl: options.gatewayUrl,
    connectorToken: options.connectorToken,
  });
  const reporter: Reporter = createReporter({
    gatewayUrl: options.gatewayUrl,
    connectorToken: options.connectorToken,
  });

  const call = createCaller({
    lists: channel,
    usage: reporter,
    fallback: staticFallback(options),
    defaultWorkload: options.workload,
    ...(options.providerApiKey === undefined ? {} : { providerApiKey: options.providerApiKey }),
  });

  channel.start();

  return {
    call,
    mode: (): ChannelMode => channel.mode(),
    currentList: (workload?: string): RankedList | null =>
      channel.current(workload ?? options.workload),
    close(): void {
      channel.close();
      reporter.close();
    },
  };
}

/**
 * The pre-list provider, shaped as a ranked entry so the request path has exactly one code
 * path. A separate "no list yet" branch inside `call.ts` would be a second failover
 * implementation that only runs during the least-tested minute of the connector's life.
 */
export function staticFallback(options: ConnectorOptions): RankedProvider {
  return {
    providerId: "fallback",
    baseUrl: options.fallbackBaseUrl,
    model: options.fallbackModel,
    host: "static",
    region: "unknown",
    reservationId: null,
    addressingModel: null,
  };
}

export { createCaller } from "./call.js";
export { createChannel, backoffDelayMs, parseEventStream } from "./channel.js";
export { createReporter, isStrainEvidence } from "./report.js";
export { withUnmetHeader, TARGET_UNMET_HEADER } from "./headers.js";
export { loadConnectorOptions, ConfigError } from "./config.js";
export type * from "./types.js";
