import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DirectiveScheduler } from "../src/controlplane/directives.js";
import { computeRankedList } from "../src/controlplane/rankedList.js";
import { chooseProvider } from "../src/routing/chooseProvider.js";
import type { Provider, ProviderObservation, ProviderState, Workload } from "../src/types.js";

/**
 * The two pure halves of the control plane, proven without a socket.
 *
 * That they can be tested this way is the point of the split: the ordering is a property of
 * `chooseProvider` and the push rate is a property of a clock argument, and neither needs a
 * server to demonstrate.
 */

const FAST: Provider = {
  id: "sim-a",
  baseUrl: "http://sim-a.invalid",
  model: "sim-fast",
  host: "sim-a",
  region: "local",
  serviceTier: "standard",
};

const SLOW_CHEAP: Provider = {
  id: "sim-b",
  baseUrl: "http://sim-b.invalid",
  model: "sim-cheap",
  host: "sim-b",
  region: "local",
  serviceTier: "standard",
};

const WORKLOAD: Workload = {
  name: "default",
  allowedModels: [
    { model: "sim-fast", host: "sim-a" },
    { model: "sim-cheap", host: "sim-b" },
  ],
  dimensions: { p95_ms: 300 },
  declarationOrder: ["p95_ms"],
  objective: "cost_per_1k_tokens_usd",
  priority: ["p95_ms"],
  hard: null,
};

function observation(
  providerId: string,
  p95Ms: number,
  costPer1kTokensUsd: number,
): ProviderObservation {
  return {
    providerId,
    p95Ms,
    costPer1kTokensUsd,
    successRate: 1,
    windowSpanMs: 1_000,
    sampleCount: 50,
  };
}

function stateWith(
  observations: Record<string, ProviderObservation>,
  workload: Workload | null = WORKLOAD,
): ProviderState {
  return { providers: [FAST, SLOW_CHEAP], observations, workload };
}

const SYNTHETIC = { method: "POST", path: "/v1/chat/completions", headers: {}, body: "" };

describe("the ranked list is the routing seam's own opinion, in order", () => {
  it("puts chooseProvider's winner first and orders the rest by who wins next", () => {
    const state = stateWith({
      "sim-a": observation("sim-a", 100, 0.03),
      "sim-b": observation("sim-b", 250, 0.002),
    });

    const list = computeRankedList("default", state, { unmetDimension: null, computedAtMs: 5 });
    const inPath = chooseProvider(SYNTHETIC, state);

    assert.equal(
      list.providers[0]?.providerId,
      inPath.provider?.id,
      "the head of the list must be the provider an in-path request would have been sent to",
    );
    assert.deepEqual(
      list.providers.map((provider) => provider.providerId),
      ["sim-b", "sim-a"],
      "the cheaper provider wins the cost objective, and the other is the failover",
    );
    assert.equal(list.boundBy, "cost_per_1k_tokens_usd", "boundBy comes from the first call");
    assert.equal(list.computedAtMs, 5);
    assert.deepEqual(
      list.providers.map((provider) => [provider.reservationId, provider.addressingModel]),
      [
        [null, null],
        [null, null],
      ],
      "M1 leaves both reservation fields null for M2 to fill",
    );
  });

  it("reorders when the observations change, without any other input changing", () => {
    const cheapB = computeRankedList(
      "default",
      stateWith({
        "sim-a": observation("sim-a", 100, 0.03),
        "sim-b": observation("sim-b", 250, 0.002),
      }),
      { unmetDimension: null, computedAtMs: 1 },
    );
    const cheapA = computeRankedList(
      "default",
      stateWith({
        "sim-a": observation("sim-a", 100, 0.001),
        "sim-b": observation("sim-b", 250, 0.002),
      }),
      { unmetDimension: null, computedAtMs: 2 },
    );

    assert.deepEqual(cheapB.providers.map((p) => p.providerId), ["sim-b", "sim-a"]);
    assert.deepEqual(cheapA.providers.map((p) => p.providerId), ["sim-a", "sim-b"]);
  });

  it("carries the unmet dimension so the connector can report the same diagnosis", () => {
    const list = computeRankedList("default", stateWith({}), {
      unmetDimension: "p95_ms",
      computedAtMs: 0,
    });
    assert.equal(list.unmetDimension, "p95_ms");
  });

  it("truncates rather than offering a provider a hard dimension ruled out", () => {
    const hard: Workload = { ...WORKLOAD, hard: "p95_ms", priority: ["p95_ms"] };
    const list = computeRankedList(
      "default",
      stateWith(
        {
          "sim-a": observation("sim-a", 100, 0.03),
          "sim-b": observation("sim-b", 900, 0.002),
        },
        hard,
      ),
      { unmetDimension: null, computedAtMs: 0 },
    );

    assert.deepEqual(
      list.providers.map((provider) => provider.providerId),
      ["sim-a"],
      "sim-b breaches a hard ceiling; offering it as failover would breach it by another route",
    );
  });
});

describe("the push scheduler caps how often one workload can move", () => {
  function draft(order: readonly string[], computedAtMs: number) {
    return {
      workload: "default",
      providers: order.map((providerId) => ({
        providerId,
        baseUrl: `http://${providerId}.invalid`,
        model: providerId,
        host: providerId,
        region: "local",
        reservationId: null,
        addressingModel: null,
      })),
      unmetDimension: null,
      boundBy: null,
      computedAtMs,
    };
  }

  it("pushes at most once per workload per second no matter how fast the order flaps", () => {
    const scheduler = new DirectiveScheduler({ debounceMs: 1_000, readPersistedVersion: () => 0 });
    let pushes = 0;

    for (let tick = 0; tick < 20; tick += 1) {
      // A provider hovering on a target: the order inverts on every single tick.
      const order = tick % 2 === 0 ? ["a", "b"] : ["b", "a"];
      if (scheduler.offer(draft(order, tick * 50), tick * 50) !== null) pushes += 1;
      pushes += scheduler.flush(tick * 50).length;
    }

    assert.equal(pushes, 1, "one second of flapping costs exactly one push");
    assert.equal(scheduler.published("default")?.version, 1);
  });

  it("still delivers the last suppressed change once the window passes", () => {
    const scheduler = new DirectiveScheduler({ debounceMs: 1_000, readPersistedVersion: () => 0 });

    assert.equal(scheduler.offer(draft(["a", "b"], 0), 0)?.version, 1);
    assert.equal(scheduler.offer(draft(["b", "a"], 500), 500), null, "inside the window");
    assert.deepEqual(scheduler.flush(999), [], "still inside the window");

    const flushed = scheduler.flush(1_000);
    assert.equal(flushed.length, 1, "the held change is published, not lost");
    assert.equal(flushed[0]?.version, 2);
    assert.deepEqual(flushed[0]?.providers.map((p) => p.providerId), ["b", "a"]);
  });

  it("says nothing when the list did not change, however long it has been", () => {
    const scheduler = new DirectiveScheduler({ debounceMs: 10, readPersistedVersion: () => 0 });
    assert.notEqual(scheduler.offer(draft(["a"], 0), 0), null);
    assert.equal(scheduler.offer(draft(["a"], 10_000), 10_000), null);
    assert.equal(scheduler.published("default")?.version, 1, "a recomputation is not a change");
  });

  it("never reissues a version the store says was already delivered", () => {
    const scheduler = new DirectiveScheduler({ debounceMs: 0, readPersistedVersion: () => 7 });
    assert.equal(scheduler.offer(draft(["a"], 0), 0)?.version, 8, "restarts resume, not rewind");
    assert.equal(scheduler.offer(draft(["b"], 1), 1)?.version, 9);
  });
});
