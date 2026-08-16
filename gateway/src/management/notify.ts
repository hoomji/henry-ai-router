import { createHmac, timingSafeEqual } from "node:crypto";

import type { UnmetState } from "../types.js";

/**
 * The `unmet` transition notification.
 *
 * `management/` is a sibling of `server.ts` rather than part of it: these surfaces are
 * control-plane, serve no customer model traffic, and must be able to fail without
 * touching the data path. This module is the clearest case — every failure mode here ends
 * in the notification being dropped, and nothing about a dropped notification is allowed
 * to reach a request.
 *
 * The spec is explicit that this is "a notification, never the record: an undeliverable
 * notification may be dropped, because the status resource still holds the truth". So the
 * retry is bounded and the give-up is deliberate, not a bug to be fixed later.
 */

/** Carries the HMAC over the body, so a receiver can prove the gateway sent it. */
export const SIGNATURE_HEADER = "x-gateway-signature";

export interface UnmetNotification {
  readonly event: "unmet_entered" | "unmet_left";
  readonly workload: string;
  readonly state: UnmetState;
  readonly atMs: number;
}

/** Hex SHA-256 HMAC of the exact bytes sent, computed with the per-customer secret. */
export function signBody(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/**
 * Constant-time signature check, exported so the load script and tests verify a delivery
 * the way a customer would rather than by string equality.
 */
export function verifySignature(body: string, secret: string, signature: string): boolean {
  const expected = Buffer.from(signBody(body, secret), "utf8");
  const actual = Buffer.from(signature, "utf8");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

export interface NotifierOptions {
  /** How long delivery is retried before the notification is dropped. */
  readonly retryMs: number;
  /** First backoff step; doubles up to a cap until the budget is spent. */
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
  /** Injected so tests drive delivery without a real network or real waiting. */
  readonly fetchImpl?: typeof fetch;
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface DeliveryOutcome {
  readonly delivered: boolean;
  readonly attempts: number;
  /** Set when the retry budget was spent without a delivery, for the log line. */
  readonly droppedReason: string | null;
}

/**
 * Deliver `unmet` transitions, at-least-once within a bounded budget.
 *
 * At-least-once rather than exactly-once because the alternative — holding a request
 * until a customer's endpoint acknowledges — would make their outage ours. De-duplication
 * of the transition itself happens upstream of this module: only the process that wins the
 * store's compare-and-set on the `unmet` state calls `deliver`, so a redelivery here is a
 * repeat of one genuine transition rather than several processes reporting the same one.
 */
export class UnmetNotifier {
  readonly #options: Required<Omit<NotifierOptions, "fetchImpl">> & { fetchImpl: typeof fetch };
  #inFlight = 0;

  constructor(options: NotifierOptions) {
    this.#options = {
      retryMs: options.retryMs,
      initialBackoffMs: options.initialBackoffMs ?? 500,
      maxBackoffMs: options.maxBackoffMs ?? 30_000,
      fetchImpl: options.fetchImpl ?? fetch,
      nowMs: options.nowMs ?? (() => Date.now()),
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    };
  }

  /** Notifications still being retried. Exposed so tests can await quiescence. */
  get inFlight(): number {
    return this.#inFlight;
  }

  async deliver(
    url: string | null,
    secret: string | null,
    notification: UnmetNotification,
  ): Promise<DeliveryOutcome> {
    if (url === null) {
      return { delivered: false, attempts: 0, droppedReason: "no notification URL configured" };
    }

    const body = JSON.stringify(notification);
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (secret !== null) headers[SIGNATURE_HEADER] = signBody(body, secret);

    const deadline = this.#options.nowMs() + this.#options.retryMs;
    let backoff = this.#options.initialBackoffMs;
    let attempts = 0;
    let lastError = "no attempt was made";

    this.#inFlight += 1;
    try {
      while (this.#options.nowMs() < deadline) {
        attempts += 1;
        try {
          const response = await this.#options.fetchImpl(url, { method: "POST", headers, body });
          if (response.ok) return { delivered: true, attempts, droppedReason: null };
          lastError = `endpoint returned ${response.status}`;
        } catch (error) {
          lastError = `delivery failed: ${String(error)}`;
        }

        // Stop before sleeping past the budget: the point of the deadline is that the
        // gateway stops caring, not that it sleeps politely until it does.
        if (this.#options.nowMs() + backoff >= deadline) break;
        await this.#options.sleep(backoff);
        backoff = Math.min(backoff * 2, this.#options.maxBackoffMs);
      }

      return { delivered: false, attempts, droppedReason: lastError };
    } finally {
      this.#inFlight -= 1;
    }
  }
}
