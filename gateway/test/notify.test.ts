import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  SIGNATURE_HEADER,
  UnmetNotifier,
  signBody,
  verifySignature,
} from "../src/management/notify.js";
import type { UnmetNotification } from "../src/management/notify.js";
import type { UnmetState } from "../src/types.js";

const STATE: UnmetState = {
  workload: "checkout",
  unmet: true,
  since: 1_000,
  report: null,
  missedStreak: 3,
  heldStreak: 0,
  lastWindowAtMs: 1_000,
};

const NOTIFICATION: UnmetNotification = {
  event: "unmet_entered",
  workload: "checkout",
  state: STATE,
  atMs: 1_000,
};

const URL = "https://customer.invalid/hook";
const SECRET = "shared-secret";
const RETRY_MS = 15 * 60_000;

interface Recorded {
  readonly url: string;
  readonly body: string;
  readonly headers: Record<string, string>;
}

/**
 * A fake clock plus a fake `sleep` that advances it. Nothing here waits on real time: a
 * test that actually burned the 15-minute retry budget would be a broken test.
 */
function fakeClock(startMs = 0) {
  let now = startMs;
  const sleeps: number[] = [];
  return {
    nowMs: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
    get now() {
      return now;
    },
  };
}

/** Records every request and answers with a caller-supplied status sequence. */
function fakeFetch(respond: (attempt: number) => Response | Error) {
  const calls: Recorded[] = [];
  const impl = (async (url: unknown, init: unknown) => {
    const request = init as { headers: Record<string, string>; body: string };
    calls.push({ url: String(url), body: request.body, headers: { ...request.headers } });
    const result = respond(calls.length);
    if (result instanceof Error) throw result;
    return result;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ok = () => new Response("", { status: 200 });
const failing = () => new Response("", { status: 503 });

describe("the unmet notifier", () => {
  it("delivers on a 2xx first response and makes exactly one attempt", async () => {
    const clock = fakeClock();
    const fetcher = fakeFetch(ok);
    const notifier = new UnmetNotifier({
      retryMs: RETRY_MS,
      fetchImpl: fetcher.impl,
      nowMs: clock.nowMs,
      sleep: clock.sleep,
    });

    const outcome = await notifier.deliver(URL, SECRET, NOTIFICATION);

    assert.equal(outcome.delivered, true, "a 2xx endpoint is a delivered notification");
    assert.equal(outcome.attempts, 1, "a successful delivery must not be retried");
    assert.equal(outcome.droppedReason, null);
    assert.equal(fetcher.calls.length, 1, "one delivery is one request to the customer");
  });

  it("retries a failing endpoint with doubling backoff and then drops the notification", async () => {
    const clock = fakeClock();
    const fetcher = fakeFetch(failing);
    const notifier = new UnmetNotifier({
      retryMs: RETRY_MS,
      initialBackoffMs: 500,
      fetchImpl: fetcher.impl,
      nowMs: clock.nowMs,
      sleep: clock.sleep,
    });

    const outcome = await notifier.deliver(URL, SECRET, NOTIFICATION);

    assert.deepEqual(
      clock.sleeps.slice(0, 4),
      [500, 1_000, 2_000, 4_000],
      "backoff must double between attempts rather than hammering a struggling endpoint",
    );
    assert.equal(
      outcome.delivered,
      false,
      "dropping is the intended end of a spent budget: the status resource is the record, " +
        "and the notification never is",
    );
    assert.ok(
      outcome.attempts > 1 && outcome.attempts < 100,
      `a spent budget means several bounded attempts, got ${outcome.attempts}`,
    );
    assert.equal(
      outcome.droppedReason,
      "endpoint returned 503",
      "the drop must carry the last failure so the log line explains itself",
    );
  });

  it("never sleeps past the retry deadline", async () => {
    const clock = fakeClock(10_000);
    const deadline = 10_000 + RETRY_MS;
    const fetcher = fakeFetch(failing);
    const notifier = new UnmetNotifier({
      retryMs: RETRY_MS,
      fetchImpl: fetcher.impl,
      nowMs: clock.nowMs,
      sleep: clock.sleep,
    });

    await notifier.deliver(URL, SECRET, NOTIFICATION);

    assert.ok(
      clock.now < deadline,
      `the gateway stops caring at the deadline rather than sleeping politely past it: ` +
        `clock reached ${clock.now}, deadline ${deadline}`,
    );
  });

  it("treats a connection error as a failed delivery instead of propagating it", async () => {
    const clock = fakeClock();
    let thrown = 0;
    const fetcher = fakeFetch(() => {
      thrown += 1;
      return new Error("ECONNREFUSED");
    });
    const notifier = new UnmetNotifier({
      retryMs: RETRY_MS,
      fetchImpl: fetcher.impl,
      nowMs: clock.nowMs,
      sleep: clock.sleep,
    });

    // Resolving rather than rejecting is the guarantee that a customer's outage does not
    // become ours: no caller of deliver() should ever have to catch.
    const outcome = await notifier.deliver(URL, SECRET, NOTIFICATION);

    assert.equal(outcome.delivered, false);
    assert.ok(thrown > 1, "a connection error must be retried, not abandoned after one try");
    assert.match(
      outcome.droppedReason ?? "",
      /delivery failed/,
      "the transport failure must be recorded as the drop reason, not swallowed",
    );
  });

  it("caps the backoff at maxBackoffMs", async () => {
    const clock = fakeClock();
    const fetcher = fakeFetch(failing);
    const notifier = new UnmetNotifier({
      retryMs: RETRY_MS,
      initialBackoffMs: 1_000,
      maxBackoffMs: 4_000,
      fetchImpl: fetcher.impl,
      nowMs: clock.nowMs,
      sleep: clock.sleep,
    });

    await notifier.deliver(URL, SECRET, NOTIFICATION);

    assert.ok(clock.sleeps.length > 4, "the budget should allow enough retries to reach the cap");
    assert.ok(
      clock.sleeps.every((ms) => ms <= 4_000),
      `no wait may exceed the cap, got ${JSON.stringify(clock.sleeps)}`,
    );
    assert.equal(
      clock.sleeps.at(-1),
      4_000,
      "backoff must settle at the cap rather than growing without bound",
    );
  });

  it("treats a null URL as a no-op rather than an error", async () => {
    const fetcher = fakeFetch(ok);
    const notifier = new UnmetNotifier({ retryMs: RETRY_MS, fetchImpl: fetcher.impl });

    const outcome = await notifier.deliver(null, SECRET, NOTIFICATION);

    assert.deepEqual(
      outcome,
      {
        delivered: false,
        attempts: 0,
        droppedReason: "no notification URL configured",
      },
      "a customer who configured no endpoint has not made an error",
    );
    assert.equal(fetcher.calls.length, 0, "there is nowhere to send an unconfigured notification");
  });

  it("signs the exact bytes it sends, and the signature rejects a tampered body", async () => {
    const fetcher = fakeFetch(ok);
    const notifier = new UnmetNotifier({ retryMs: RETRY_MS, fetchImpl: fetcher.impl });

    await notifier.deliver(URL, SECRET, NOTIFICATION);

    const sent = fetcher.calls[0];
    assert.ok(sent, "the notifier must have sent a request");
    const signature = sent.headers[SIGNATURE_HEADER];
    assert.ok(signature, `the body must be signed under ${SIGNATURE_HEADER}`);
    // Verify against the bytes the fetchImpl received, not a re-serialization: the
    // signature covers what was actually sent, and any re-encoding could differ.
    assert.equal(
      verifySignature(sent.body, SECRET, signature),
      true,
      "a receiver must be able to prove the gateway sent these exact bytes",
    );
    assert.equal(
      verifySignature(`${sent.body} `, SECRET, signature),
      false,
      "a tampered body must not verify, or the signature proves nothing",
    );
    assert.equal(
      verifySignature(sent.body, "other-secret", signature),
      false,
      "only the per-customer secret may produce an accepted signature",
    );
    assert.equal(signature, signBody(sent.body, SECRET));
  });

  it("sends no signature header when no secret is configured, and still delivers", async () => {
    const fetcher = fakeFetch(ok);
    const notifier = new UnmetNotifier({ retryMs: RETRY_MS, fetchImpl: fetcher.impl });

    const outcome = await notifier.deliver(URL, null, NOTIFICATION);

    assert.equal(outcome.delivered, true, "an unsigned endpoint is still a working endpoint");
    assert.equal(
      fetcher.calls[0]?.headers[SIGNATURE_HEADER],
      undefined,
      "without a secret there is nothing to sign, so no signature may be claimed",
    );
  });

  it("reports zero in flight once a delivery settles", async () => {
    const clock = fakeClock();
    const fetcher = fakeFetch(failing);
    const notifier = new UnmetNotifier({
      retryMs: RETRY_MS,
      fetchImpl: fetcher.impl,
      nowMs: clock.nowMs,
      sleep: clock.sleep,
    });

    assert.equal(notifier.inFlight, 0, "an idle notifier holds nothing");
    const pending = notifier.deliver(URL, SECRET, NOTIFICATION);
    assert.equal(notifier.inFlight, 1, "a retrying notification is still in flight");
    await pending;

    assert.equal(notifier.inFlight, 0, "a dropped notification must not leak an in-flight count");
  });
});
