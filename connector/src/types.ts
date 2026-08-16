/**
 * Plain-data shapes on the connector <-> gateway wire, plus the connector's own options.
 *
 * These mirror the frozen wire contract for the connector milestone. Nothing here imports
 * a server type, and nothing here reads a clock: a time is always an explicit `...Ms`
 * number a caller supplies, which is what lets the buffering and failover rules be tested
 * without faking global time.
 *
 * The connector's vocabulary is deliberately smaller than the gateway's. It knows nothing
 * of targets, dimensions, percentiles or capability floors — ADR 0006 keeps routing policy
 * gateway-side, so the only routing input this package understands is an *ordering*.
 */

/** The dimensions a workload can miss. Repeated here rather than imported: the two
 * packages ship separately, and a shared build dependency would make installing the
 * connector a decision about the gateway. */
export type DimensionName = "p95_ms" | "cost_per_1k_tokens_usd" | "success_rate";

/** One provider in a ranked list, as the gateway describes it. */
export interface RankedProvider {
  readonly providerId: string;
  /** Base URL of the provider, without a trailing slash. */
  readonly baseUrl: string;
  /** The model the caller's request should name, absent an `addressingModel`. */
  readonly model: string;
  readonly host: string;
  readonly region: string;
  /**
   * Set when calling this provider consumes pre-paid capacity. The connector only records
   * it on the usage record; deciding *whether* a reservation should be addressed is a
   * routing decision and therefore the gateway's (M2 fills this in).
   */
  readonly reservationId: string | null;
  /**
   * The string to send as the request's `model` instead of what the caller asked for.
   * On Bedrock this is the provisioned-model ARN; sending the foundation model identifier
   * instead is the mistake that silently bills on-demand while a reservation sits idle.
   */
  readonly addressingModel: string | null;
}

/** The gateway's routing decision for one workload, and the entirety of what the
 * connector knows about routing. */
export interface RankedList {
  readonly workload: string;
  /** Monotonic per (customer, workload). What an acknowledgement names. */
  readonly version: number;
  /** Highest preference first. The connector's one rule walks this order. */
  readonly providers: readonly RankedProvider[];
  /** Non-null when no provider mix held the target; surfaced as a response header. */
  readonly unmetDimension: DimensionName | null;
  readonly boundBy: DimensionName | null;
  readonly computedAtMs: number;
}

/**
 * One completed provider call, as reported back to the gateway.
 *
 * One record, two consumers with different tolerances for loss: as *usage* it computes a
 * bill, as a *strain contribution* it is evidence of a burst. `report.ts` is where that
 * split becomes two buffers.
 */
export interface UsageRecord {
  readonly workload: string;
  readonly providerId: string;
  readonly model: string;
  readonly region: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Provider-attributable latency: time to last byte from the provider. */
  readonly latencyMs: number;
  /** The provider's HTTP status, or `0` for a transport failure. A status rather than a
   * success boolean because 429 and 5xx are distinct signals to the strain aggregate. */
  readonly statusCode: number;
  /**
   * Raw rate-limit headers as the provider sent them. They are what lets a 429 caused by
   * the customer's own quota be excluded from strain; without them that exclusion cannot
   * be made at all, so they are carried unparsed rather than interpreted here.
   */
  readonly rateLimitLimit: string | null;
  readonly rateLimitReset: string | null;
  readonly reservationId: string | null;
  readonly atMs: number;
}

/** A chat-completion request as the customer's application wrote it. Passed through
 * essentially untouched; the connector only ever rewrites `model`. */
export interface ChatRequest {
  readonly model: string;
  readonly stream?: boolean;
  readonly [key: string]: unknown;
}

/**
 * What `call()` hands back.
 *
 * `body` and `stream` are exclusive: a streamed request yields the provider's stream so
 * the caller can consume it as it arrives. Returning a buffered string for both would be
 * a smaller API and would silently break the one property the plan says to prove.
 */
export interface ConnectorResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** The full body, for a non-streamed request. `null` when `stream` is set. */
  readonly body: string | null;
  /** The relayed response stream, for a streamed request. `null` otherwise. */
  readonly stream: ReadableStream<Uint8Array> | null;
  /** Which provider actually answered, after any failover. */
  readonly providerId: string;
}

/** How the channel is currently receiving lists. `poll` is the documented degraded mode. */
export type ChannelMode = "push" | "poll";

/** Everything the connector needs to run, resolved from the environment by `config.ts`. */
export interface ConnectorOptions {
  readonly gatewayUrl: string;
  readonly connectorToken: string;
  readonly workload: string;
  /**
   * The statically configured provider used before any list has ever arrived. This is what
   * makes the connector safe to install while the gateway is still unreachable.
   */
  readonly fallbackBaseUrl: string;
  readonly fallbackModel: string;
  /** The customer's own provider credential. The gateway never holds one. */
  readonly providerApiKey?: string;
}
