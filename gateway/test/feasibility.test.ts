import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { CapabilityFloor, DimensionName, Workload } from "../src/types.js";
import {
  CAPABILITY_FLOORS,
  CATALOGUE_EPOCH_MS,
  bestFloor,
  floorsFor,
  isStale,
} from "../src/providers/capabilities.js";
import { checkFeasibility } from "../src/targets/feasibility.js";

/** Every catalogue floor is fresh at the epoch, so this is "now" unless a test says else. */
const NOW_MS = CATALOGUE_EPOCH_MS;

const HOUR_MS = 3_600_000;

/** A workload stating only what a test cares about; the rest is inert here. */
function workload(
  dimensions: Partial<Record<DimensionName, number>>,
  allowedModels: Workload["allowedModels"] = [
    { model: "sim-fast", host: null },
    { model: "sim-cheap", host: null },
  ],
): Workload {
  const declarationOrder = Object.keys(dimensions) as DimensionName[];
  return {
    name: "checkout",
    allowedModels,
    dimensions,
    declarationOrder,
    objective: "none",
    priority: [...declarationOrder].reverse(),
    hard: null,
  };
}

function floor(overrides: Partial<CapabilityFloor> & { dimension: DimensionName }): CapabilityFloor {
  return {
    model: "sim-fast",
    host: "sim-a",
    region: "local",
    serviceTier: "standard",
    providerId: "sim-a",
    value: 100,
    variance: 10,
    provenance: "measured",
    observedAtMs: NOW_MS - HOUR_MS,
    ttlMs: 6 * HOUR_MS,
    ...overrides,
  };
}

describe("the capability floor catalogue", () => {
  it("matches any host for a bare model and only the pinned host for a pinned one", () => {
    const anyHost = floorsFor("claude-sonnet-5", null, "p95_ms");
    assert.deepEqual(
      anyHost.map((entry) => entry.host).sort(),
      ["anthropic", "bedrock"],
      "a bare allowed_models entry accepts any host serving that model, so every host's floor is evidence",
    );

    const pinned = floorsFor("claude-sonnet-5", "bedrock", "p95_ms");
    assert.deepEqual(
      pinned.map((entry) => entry.host),
      ["bedrock"],
      "pinning a host must exclude the other host's capability, which is the point of pinning",
    );
  });

  it("treats a floor past its TTL as stale and one inside it as trustworthy", () => {
    const fresh = floor({ dimension: "p95_ms", observedAtMs: NOW_MS - HOUR_MS });
    const old = floor({ dimension: "p95_ms", observedAtMs: NOW_MS - 7 * HOUR_MS });

    assert.equal(isStale(fresh, NOW_MS), false, "a floor inside its TTL can support a rejection");
    assert.equal(isStale(old, NOW_MS), true, "past observedAtMs + ttlMs a floor is no longer trusted");
  });

  it("picks the lowest floor for a ceiling and the highest for success_rate", () => {
    const latency = bestFloor(floorsFor("sim-fast", null, "p95_ms").concat(floorsFor("sim-cheap", null, "p95_ms")), "p95_ms");
    assert.equal(latency?.providerId, "sim-a", "the most optimistic latency floor is the lowest one");

    const success = bestFloor(
      [
        floor({ dimension: "success_rate", value: 0.98, providerId: "sim-b" }),
        floor({ dimension: "success_rate", value: 0.995, providerId: "sim-a" }),
      ],
      "success_rate",
    );
    assert.equal(success?.providerId, "sim-a", "success_rate is a floor, so the most optimistic value is the highest one");
  });

  it("keeps the simulated providers' floors fresh long after the real models' have decayed", () => {
    // A year past the epoch: every real model's floor (12h to 30d) is long gone.
    const LATER_MS = CATALOGUE_EPOCH_MS + 365 * 24 * HOUR_MS;

    for (const entry of CAPABILITY_FLOORS.filter((row) => row.model.startsWith("sim-"))) {
      assert.equal(
        isStale(entry, LATER_MS),
        false,
        `${entry.model}@${entry.host}/${entry.dimension}: a simulated provider's floor must not decay, or the declaration-time check abstains forever and no target is ever rejected in a real run`,
      );
    }

    const rejection = checkFeasibility(workload({ p95_ms: 1 }), LATER_MS);
    assert.equal(
      rejection.status,
      "infeasible",
      "infeasible_by_declaration must still fire against the sim providers at wall-clock time, not only in a test pinned to the epoch",
    );

    // The other half of the pair: a real model's floor does decay, which is what keeps the
    // abstention path demonstrable. Fixing one of these by breaking the other is the bug.
    const abstention = checkFeasibility(
      workload({ p95_ms: 1 }, [{ model: "claude-sonnet-5", host: null }]),
      LATER_MS,
    );
    assert.equal(
      abstention.status,
      "abstained",
      "a real model's floor is a measurement and must go stale, so the spec's abstention path stays observable",
    );
  });

  it("carries a provenance, a variance and a TTL on every entry", () => {
    for (const entry of CAPABILITY_FLOORS) {
      assert.ok(entry.variance > 0, `${entry.model}@${entry.host}/${entry.dimension} must state an honest variance`);
      assert.ok(entry.ttlMs > 0, `${entry.model}@${entry.host}/${entry.dimension} must state a TTL so it can go stale`);
      assert.ok(
        entry.observedAtMs <= CATALOGUE_EPOCH_MS,
        "observedAtMs is stated relative to the fixed epoch, never to a clock read",
      );
      if (entry.dimension === "cost_per_1k_tokens_usd") {
        assert.ok(
          typeof entry.assumption === "string" && entry.assumption.length > 0,
          "a cost floor assumes a traffic shape and must disclose it",
        );
      }
    }
  });
});

describe("the declaration-time feasibility check", () => {
  it("rejects a plainly impossible latency target and discloses the basis of the rejection", () => {
    const result = checkFeasibility(workload({ p95_ms: 1 }), NOW_MS);

    assert.equal(result.status, "infeasible", "1 ms fails the best floor by far more than its variance");
    if (result.status !== "infeasible") return;

    const report = result.reports[0];
    assert.equal(result.reports.length, 1);
    assert.equal(report?.dimension, "p95_ms");
    assert.equal(report?.requested, 1);
    assert.equal(report?.bestAchievable, 120, "the report names the best achievable value, not the target");
    assert.equal(report?.providerId, "sim-a", "a rejection must name the provider that came closest");
    assert.equal(report?.model, "sim-fast");
    assert.equal(report?.host, "sim-a");
    assert.equal(report?.floorProvenance, "measured", "a rejection must disclose where its floor came from");
    assert.equal(report?.floorAgeMs, 30 * 60_000, "a rejection must disclose how old its floor is");
    assert.equal(report?.workload, "checkout");
  });

  it("accepts a target that fails the best floor by less than that floor's own variance", () => {
    // The best latency floor is 120 with variance 25; 95 sits exactly on the band's edge.
    const onTheEdge = checkFeasibility(workload({ p95_ms: 95 }), NOW_MS);
    assert.equal(onTheEdge.status, "feasible", "rejection is biased against itself: the variance band is accepted");

    const inside = checkFeasibility(workload({ p95_ms: 100 }), NOW_MS);
    assert.equal(inside.status, "feasible", "a target inside the variance band is never rejected");

    const beyond = checkFeasibility(workload({ p95_ms: 94 }), NOW_MS);
    assert.equal(beyond.status, "infeasible", "past the band's far edge the rejection is warranted");
  });

  it("abstains and accepts the write when every floor for a dimension is stale", () => {
    const stale = [floor({ dimension: "p95_ms", observedAtMs: NOW_MS - 48 * HOUR_MS })];
    const result = checkFeasibility(
      workload({ p95_ms: 1 }, [{ model: "sim-fast", host: null }]),
      NOW_MS,
      stale,
    );

    assert.equal(result.status, "abstained", "untrusted evidence must never produce a rejection");
    if (result.status !== "abstained") return;
    assert.deepEqual(result.staleDimensions, ["p95_ms"]);
    assert.ok(
      result.detail.includes("p95_ms") && result.detail.includes("checkout"),
      "the abstention must be observable: the detail sentence names the workload and the dimension",
    );
  });

  it("abstains rather than rejecting when no candidate has a floor for the dimension at all", () => {
    const result = checkFeasibility(
      workload({ success_rate: 0.9999 }, [{ model: "model-nobody-measured", host: null }]),
      NOW_MS,
    );

    assert.equal(result.status, "abstained", "absent evidence is not evidence of impossibility");
  });

  it("lets a rejection on a fresh dimension win over an abstention on another", () => {
    const catalogue = [
      floor({ dimension: "p95_ms", value: 400, variance: 20 }),
      floor({ dimension: "success_rate", value: 0.99, observedAtMs: NOW_MS - 48 * HOUR_MS }),
    ];
    const result = checkFeasibility(
      workload({ p95_ms: 10, success_rate: 0.9999 }, [{ model: "sim-fast", host: null }]),
      NOW_MS,
      catalogue,
    );

    assert.equal(result.status, "infeasible", "abstaining on one dimension says nothing about an impossible other");
    if (result.status !== "infeasible") return;
    assert.deepEqual(
      result.reports.map((entry) => entry.dimension),
      ["p95_ms"],
      "only the dimension with trustworthy evidence is reported",
    );
  });

  it("rejects a success_rate above the best floor and accepts one below it", () => {
    // success_rate runs the other way: the best floor is 0.995 with variance 0.003, so
    // rejection is `requested > value + variance`, not `<  value - variance`.
    const tooHigh = checkFeasibility(workload({ success_rate: 0.99999 }), NOW_MS);
    assert.equal(tooHigh.status, "infeasible", "asking for more reliability than any candidate can give is infeasible");
    if (tooHigh.status === "infeasible") {
      assert.equal(tooHigh.reports[0]?.bestAchievable, 0.995);
      assert.equal(tooHigh.reports[0]?.providerId, "sim-a");
    }

    const withinBand = checkFeasibility(workload({ success_rate: 0.998 }), NOW_MS);
    assert.equal(withinBand.status, "feasible", "0.995 + 0.003 is inside the band and must be accepted");

    const modest = checkFeasibility(workload({ success_rate: 0.9 }), NOW_MS);
    assert.equal(modest.status, "feasible", "a target below the best floor is plainly achievable");
  });

  it("states the workload shape it assumed when it rejects a cost target", () => {
    const result = checkFeasibility(workload({ cost_per_1k_tokens_usd: 0.00001 }), NOW_MS);

    assert.equal(result.status, "infeasible");
    if (result.status !== "infeasible") return;
    assert.equal(result.reports[0]?.providerId, "sim-b", "the cheapest candidate is the most optimistic one");
    assert.equal(
      result.reports[0]?.assumption,
      "assuming 1:3 input:output under 200k context, standard tier",
      "a cost rejection must disclose the traffic shape its floor assumed",
    );
  });

  it("reports every failing dimension rather than stopping at the first", () => {
    const result = checkFeasibility(
      workload({ p95_ms: 1, cost_per_1k_tokens_usd: 0.00001, success_rate: 0.99999 }),
      NOW_MS,
    );

    assert.equal(result.status, "infeasible");
    if (result.status !== "infeasible") return;
    assert.deepEqual(
      result.reports.map((entry) => entry.dimension),
      ["p95_ms", "cost_per_1k_tokens_usd", "success_rate"],
      "a customer fixing one dimension should not have to resubmit to discover the next",
    );
  });

  it("accepts a workload that states no dimensions at all", () => {
    assert.equal(checkFeasibility(workload({}), NOW_MS).status, "feasible");
  });

  it("bounds the candidate set by allowed_models", () => {
    // sim-cheap is slower but cheaper; pinning to it alone changes which floor binds.
    const result = checkFeasibility(
      workload({ p95_ms: 200 }, [{ model: "sim-cheap", host: "sim-b" }]),
      NOW_MS,
    );

    assert.equal(result.status, "infeasible", "200 ms fails sim-cheap's 380 ms floor by more than its 60 ms variance");
    if (result.status !== "infeasible") return;
    assert.equal(result.reports[0]?.providerId, "sim-b", "sim-a is not a candidate, so its faster floor cannot be used");
  });
});
