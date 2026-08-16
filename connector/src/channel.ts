import type { ChannelMode, RankedList } from "./types.js";

/**
 * The control-plane channel: how the connector learns what the gateway decided.
 *
 * Server-Sent Events rather than WebSockets because the traffic is one-directional, needs
 * no protocol upgrade, and survives the ordinary HTTP proxies a customer's network puts in
 * front of an outbound connection. The connector is code installed in someone else's
 * application; every additional thing that can be blocked at their edge is a support call.
 *
 * When the stream drops, the connector reconnects with exponential backoff and, while
 * disconnected, polls instead. Polling is the *documented degraded mode*, not a silent
 * equivalent: a polled list is acknowledged much later than a pushed one, which is exactly
 * how the gateway detects that a connector's directives are arriving late without needing
 * the connector to confess it.
 */

/** Backoff between reconnects: doubling from half a second, capped near thirty seconds.
 * A cap rather than unbounded growth because a gateway that comes back after an hour must
 * be noticed within seconds, and a floor above zero because a gateway refusing connections
 * must not be spun against. */
export function backoffDelayMs(attempt: number, baseMs = 500, capMs = 30_000): number {
  const grown = baseMs * 2 ** Math.max(0, attempt);
  return Math.min(capMs, grown);
}

export interface ChannelOptions {
  readonly gatewayUrl: string;
  readonly connectorToken: string;
  /** How often to pull lists while the stream is down. */
  readonly pollIntervalMs?: number;
  readonly backoffBaseMs?: number;
  readonly backoffCapMs?: number;
  /** Observes every backoff the reconnect loop takes, so its growth is testable without
   * waiting out the real delays. */
  readonly onBackoff?: (delayMs: number, attempt: number) => void;
  /** Injected in tests to collapse the wall-clock cost of proving the growth curve. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface Channel {
  /** Begins the reconnect loop. Returns immediately; nothing in the request path waits
   * for a list to arrive, because the fallback provider covers that window. */
  start(): void;
  /** The most recent list for a workload, or `null` if none has ever arrived. */
  current(workload: string): RankedList | null;
  /** Whether lists are currently arriving pushed or polled. */
  mode(): ChannelMode;
  close(): void;
}

export function createChannel(options: ChannelOptions): Channel {
  const pollIntervalMs = options.pollIntervalMs ?? 30_000;
  const backoffBaseMs = options.backoffBaseMs ?? 500;
  const backoffCapMs = options.backoffCapMs ?? 30_000;
  const sleep = options.sleep ?? defaultSleep;

  const lists = new Map<string, RankedList>();
  let mode: ChannelMode = "poll";
  let closed = false;
  let controller: AbortController | null = null;
  let pollTimer: NodeJS.Timeout | null = null;

  function authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${options.connectorToken}` };
  }

  /** Store a list and acknowledge it. The acknowledgement is what proves the connector
   * actually adopted the directive, so it is sent the moment the list is held rather than
   * batched with anything else. */
  function adopt(list: RankedList): void {
    const held = lists.get(list.workload);
    // Versions are monotonic per workload; a poll racing a push can deliver an older one.
    if (held !== undefined && held.version > list.version) return;
    lists.set(list.workload, list);
    void acknowledge(list);
  }

  async function acknowledge(list: RankedList): Promise<void> {
    try {
      await fetch(`${options.gatewayUrl}/v1/connector/ack`, {
        method: "POST",
        headers: { ...authHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ workload: list.workload, version: list.version }),
      });
    } catch {
      // An acknowledgement that does not land costs the gateway a delivery record, not the
      // customer a request. Nothing here may propagate.
    }
  }

  function startPolling(): void {
    if (pollTimer !== null || closed) return;
    pollTimer = setInterval(() => {
      void pollOnce();
    }, pollIntervalMs);
    pollTimer.unref();
  }

  function stopPolling(): void {
    if (pollTimer === null) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  async function pollOnce(): Promise<void> {
    try {
      const response = await fetch(`${options.gatewayUrl}/v1/connector/lists`, {
        headers: authHeaders(),
      });
      if (!response.ok) return;
      const payload = (await response.json()) as { lists?: readonly RankedList[] };
      for (const list of payload.lists ?? []) adopt(list);
    } catch {
      // The reconnect loop is what escalates a persistent failure; a missed poll is not an
      // event of its own.
    }
  }

  async function loop(): Promise<void> {
    let attempt = 0;
    while (!closed) {
      const connected = await streamOnce();
      if (closed) return;

      if (connected) {
        // A stream that carried at least one event before dropping is a healthy gateway
        // recycling a connection, not an outage; restarting the curve keeps a routine
        // reconnect from inheriting an old failure's delay.
        attempt = 0;
      }

      mode = "poll";
      startPolling();
      // Poll immediately on entering the degraded mode rather than waiting a full interval,
      // so a target change made during an outage is picked up within the poll period and
      // not within twice it.
      void pollOnce();

      const delay = backoffDelayMs(attempt, backoffBaseMs, backoffCapMs);
      options.onBackoff?.(delay, attempt);
      attempt += 1;
      await sleep(delay);
    }
  }

  /** One connection attempt. Resolves when the stream ends, `true` if it ever delivered. */
  async function streamOnce(): Promise<boolean> {
    controller = new AbortController();
    let delivered = false;
    try {
      const response = await fetch(`${options.gatewayUrl}/v1/connector/stream`, {
        headers: { ...authHeaders(), accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!response.ok || response.body === null) return false;

      mode = "push";
      stopPolling();

      for await (const list of parseEventStream(response.body)) {
        delivered = true;
        adopt(list);
      }
      return delivered;
    } catch {
      return delivered;
    } finally {
      controller = null;
    }
  }

  return {
    start(): void {
      if (closed) return;
      void loop();
    },
    current: (workload: string): RankedList | null => lists.get(workload) ?? null,
    mode: (): ChannelMode => mode,
    close(): void {
      closed = true;
      stopPolling();
      controller?.abort();
    },
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    timer.unref();
  });
}

/**
 * Parse an SSE body into ranked lists.
 *
 * Written out rather than pulled from a library because the connector holds the zero
 * runtime dependency rule most strictly of the two packages: it ships into someone else's
 * dependency tree. The subset used here is the subset the wire contract emits — `event:`,
 * `data:`, and `:` comment heartbeats — and anything else is skipped rather than guessed
 * at, so an unrecognized frame can never be mistaken for a routing directive.
 */
export async function* parseEventStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<RankedList> {
  const decoder = new TextDecoder();
  let buffered = "";

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(chunk, { stream: true });

    let boundary = buffered.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      const list = parseFrame(frame);
      if (list !== null) yield list;
      boundary = buffered.indexOf("\n\n");
    }
  }
}

function parseFrame(frame: string): RankedList | null {
  let event = "message";
  const data: string[] = [];

  for (const rawLine of frame.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }

  if (event !== "list" || data.length === 0) return null;
  try {
    return JSON.parse(data.join("\n")) as RankedList;
  } catch {
    // A malformed frame is dropped rather than escalated: the alternative is tearing down a
    // working stream over one bad line, which would cost every subsequent directive too.
    return null;
  }
}
