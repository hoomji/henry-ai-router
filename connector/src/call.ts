import { withUnmetHeader } from "./headers.js";
import type { ChatRequest, ConnectorResponse, RankedList, RankedProvider, UsageRecord } from "./types.js";

/**
 * The entry point a customer's application calls, and the whole of the request path.
 *
 * The gateway is not in this path. This function talks to providers directly, using the
 * customer's own provider credential, and its only routing input is the ordering the
 * gateway last pushed. It holds exactly one rule of its own — on a network error, a 429,
 * or a 5xx, try the next provider in the list — and deliberately no more: it never
 * evaluates a target, never measures a percentile, and never decides anything the gateway
 * could have decided for it. Two implementations of the routing decision would drift, and
 * the connector cannot see the cross-customer state a binding reason has to cite (ADR
 * 0006).
 *
 * Before any list has ever arrived it calls a statically configured fallback provider,
 * which is what makes the connector safe to install while the gateway is still unreachable.
 */

/** Headers whose presence is what lets a 429 caused by the customer's own quota be
 * excluded from the strain aggregate. Carried raw; interpreting them is the gateway's. */
const RATE_LIMIT_LIMIT_HEADERS = [
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "ratelimit-limit",
] as const;

const RATE_LIMIT_RESET_HEADERS = [
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
  "ratelimit-reset",
  "retry-after",
] as const;

/** How much of a stream's tail is retained while looking for the terminal usage frame.
 * A bounded window, not the body: buffering the body is the one thing this path must not
 * do, and a usage frame lives in the last few hundred bytes by construction. */
const USAGE_TAIL_BYTES = 8_192;

/** OpenAI-compatible token estimate, used only when a provider ends a stream without a
 * usage frame. Four characters per token is the documented rule of thumb; it is an
 * estimate and is reported as one rather than being passed off as a count. */
const CHARS_PER_ESTIMATED_TOKEN = 4;

/** Where the current ranked list comes from. An interface rather than the channel itself
 * so the request path can be exercised without a gateway on the other end. */
export interface ListSource {
  current(workload: string): RankedList | null;
}

/** Where usage records go. Fire-and-forget by contract: this must never throw. */
export interface UsageSink {
  record(record: UsageRecord): void;
}

export interface CallerOptions {
  readonly lists: ListSource;
  readonly usage: UsageSink;
  /** Used until a list arrives, and it never expires: a gateway that goes away must not
   * take the customer's traffic with it. */
  readonly fallback: RankedProvider;
  readonly defaultWorkload: string;
  /** The customer's own provider credential. The gateway is never given one. */
  readonly providerApiKey?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

export interface CallOptions {
  readonly workload?: string;
}

export type Caller = (request: ChatRequest, options?: CallOptions) => Promise<ConnectorResponse>;

export function createCaller(options: CallerOptions): Caller {
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  return async function call(
    request: ChatRequest,
    callOptions?: CallOptions,
  ): Promise<ConnectorResponse> {
    const workload = callOptions?.workload ?? options.defaultWorkload;
    const list = options.lists.current(workload);
    const candidates =
      list !== null && list.providers.length > 0 ? list.providers : [options.fallback];

    let lastResponse: ConnectorResponse | null = null;
    let lastError: unknown = null;

    for (const provider of candidates) {
      const startedAtMs = now();
      let response: Response;

      try {
        response = await doFetch(`${provider.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: providerHeaders(options.providerApiKey),
          body: JSON.stringify(addressed(request, provider)),
        });
      } catch (error) {
        // A transport failure is reported as status `0` rather than dropped: to the strain
        // aggregate a connection the provider never answered is the same event as a 5xx.
        lastError = error;
        options.usage.record(
          buildRecord({
            workload,
            provider,
            statusCode: 0,
            latencyMs: now() - startedAtMs,
            promptTokens: 0,
            completionTokens: 0,
            rateLimitLimit: null,
            rateLimitReset: null,
            atMs: now(),
          }),
        );
        continue;
      }

      const headers = withUnmetHeader(collectHeaders(response.headers), list);

      if (shouldFailOver(response.status)) {
        const body = await response.text();
        options.usage.record(
          buildRecord({
            workload,
            provider,
            statusCode: response.status,
            latencyMs: now() - startedAtMs,
            promptTokens: 0,
            completionTokens: 0,
            rateLimitLimit: firstHeader(response.headers, RATE_LIMIT_LIMIT_HEADERS),
            rateLimitReset: firstHeader(response.headers, RATE_LIMIT_RESET_HEADERS),
            atMs: now(),
          }),
        );
        lastResponse = {
          status: response.status,
          headers,
          body,
          stream: null,
          providerId: provider.providerId,
        };
        continue;
      }

      const finish = (promptTokens: number, completionTokens: number): void => {
        options.usage.record(
          buildRecord({
            workload,
            provider,
            statusCode: response.status,
            latencyMs: now() - startedAtMs,
            promptTokens,
            completionTokens,
            rateLimitLimit: firstHeader(response.headers, RATE_LIMIT_LIMIT_HEADERS),
            rateLimitReset: firstHeader(response.headers, RATE_LIMIT_RESET_HEADERS),
            atMs: now(),
          }),
        );
      };

      if (request.stream === true && response.body !== null) {
        return {
          status: response.status,
          headers,
          body: null,
          stream: relayStream(response.body, JSON.stringify(request).length, finish),
          providerId: provider.providerId,
        };
      }

      const body = await response.text();
      const counted = countFromBody(body);
      finish(counted.promptTokens, counted.completionTokens);
      return { status: response.status, headers, body, stream: null, providerId: provider.providerId };
    }

    if (lastResponse !== null) return lastResponse;
    throw new Error(
      `every provider in the ranked list for workload "${workload}" failed: ${String(lastError)}`,
    );
  };
}

/** The connector's one and only routing rule. */
function shouldFailOver(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Apply the ranked entry's addressing model.
 *
 * Rewriting `model` is the entirety of what the connector changes about a request. On
 * Bedrock, passing the foundation model identifier where the provisioned-model ARN belongs
 * routes the call to on-demand capacity while the reservation sits idle and billed — which
 * is the failure behavior 4 exists to remove.
 */
function addressed(request: ChatRequest, provider: RankedProvider): ChatRequest {
  if (provider.addressingModel === null) return request;
  return { ...request, model: provider.addressingModel };
}

function providerHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey !== undefined) headers["authorization"] = `Bearer ${apiKey}`;
  return headers;
}

function collectHeaders(headers: Headers): Record<string, string> {
  const collected: Record<string, string> = {};
  headers.forEach((value, key) => {
    collected[key] = value;
  });
  return collected;
}

function firstHeader(headers: Headers, names: readonly string[]): string | null {
  for (const name of names) {
    const value = headers.get(name);
    if (value !== null) return value;
  }
  return null;
}

function buildRecord(parts: {
  workload: string;
  provider: RankedProvider;
  statusCode: number;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  rateLimitLimit: string | null;
  rateLimitReset: string | null;
  atMs: number;
}): UsageRecord {
  return {
    workload: parts.workload,
    providerId: parts.provider.providerId,
    model: parts.provider.addressingModel ?? parts.provider.model,
    region: parts.provider.region,
    promptTokens: parts.promptTokens,
    completionTokens: parts.completionTokens,
    latencyMs: parts.latencyMs,
    statusCode: parts.statusCode,
    rateLimitLimit: parts.rateLimitLimit,
    rateLimitReset: parts.rateLimitReset,
    reservationId: parts.provider.reservationId,
    atMs: parts.atMs,
  };
}

/** Token counts from a complete, non-streamed body, as the provider reported them. */
function countFromBody(body: string): { promptTokens: number; completionTokens: number } {
  try {
    const parsed = JSON.parse(body) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
    return {
      promptTokens: parsed.usage?.prompt_tokens ?? 0,
      completionTokens: parsed.usage?.completion_tokens ?? 0,
    };
  } catch {
    return { promptTokens: 0, completionTokens: 0 };
  }
}

/**
 * Relay a streamed body to the caller as it arrives, counting tokens when it ends.
 *
 * Two properties are load-bearing and easy to lose. The first is that chunks are enqueued
 * exactly as received — the same `Uint8Array`, never re-encoded, never rewritten. Chunk
 * transformation belongs to the interception behavior, where the *gateway* is mid-stream,
 * and not here. The second is that nothing is accumulated but a bounded tail window: a
 * connector that quietly buffers the body looks correct in every test that does not measure
 * time-to-first-byte, which is why the plan requires that measurement explicitly.
 *
 * Token counting prefers the provider's terminal usage frame, which OpenAI-compatible
 * streams emit as a final `data:` object carrying `usage`. When a provider ends a stream
 * without one, the count falls back to a four-characters-per-token *estimate* over the
 * bytes seen. That is a deliberate approximation, chosen over re-reading the stream, which
 * would defeat the relay.
 */
function relayStream(
  upstream: ReadableStream<Uint8Array>,
  requestChars: number,
  finish: (promptTokens: number, completionTokens: number) => void,
): ReadableStream<Uint8Array> {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let tail = "";
  let seenChars = 0;
  let finished = false;

  const complete = (): void => {
    if (finished) return;
    finished = true;
    const reported = usageFromTail(tail);
    if (reported !== null) {
      finish(reported.promptTokens, reported.completionTokens);
      return;
    }
    finish(
      Math.ceil(requestChars / CHARS_PER_ESTIMATED_TOKEN),
      Math.ceil(seenChars / CHARS_PER_ESTIMATED_TOKEN),
    );
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      const { done, value } = await reader.read();
      if (done) {
        complete();
        controller.close();
        return;
      }
      const text = decoder.decode(value, { stream: true });
      seenChars += text.length;
      tail = (tail + text).slice(-USAGE_TAIL_BYTES);
      controller.enqueue(value);
    },
    cancel(reason): void {
      complete();
      void reader.cancel(reason);
    },
  });
}

/** The last `data:` frame in the tail that carries a usage object, if any. */
function usageFromTail(tail: string): { promptTokens: number; completionTokens: number } | null {
  let found: { promptTokens: number; completionTokens: number } | null = null;
  for (const line of tail.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice("data:".length).trim();
    if (payload === "" || payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload) as {
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
      };
      if (parsed.usage === undefined || parsed.usage === null) continue;
      found = {
        promptTokens: parsed.usage.prompt_tokens ?? 0,
        completionTokens: parsed.usage.completion_tokens ?? 0,
      };
    } catch {
      // A partially-received frame at the window edge is not an error; skip it.
    }
  }
  return found;
}
