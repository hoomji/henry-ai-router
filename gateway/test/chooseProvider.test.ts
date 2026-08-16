import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { chooseProvider } from "../src/routing/chooseProvider.js";
import { INSUFFICIENT_DATA } from "../src/types.js";
import type {
  DimensionName,
  GatewayRequest,
  Measured,
  Provider,
  ProviderObservation,
  ProviderState,
  Workload,
} from "../src/types.js";

/**
 * These tests state the policy, not the implementation. Every one of them is a snapshot in
 * and a decision out: the seam is pure, so nothing here fakes a clock, a socket, or an
 * environment, and any test that needed to would be evidence the seam had drifted.
 */

const request: GatewayRequest = {
  method: "POST",
  path: "/v1/chat/completions",
  headers: {},
  body: "",
};

function provider(id: string, model = "gpt-x", host = "openai"): Provider {
  return {
    id,
    baseUrl: `http://${id}.invalid`,
    model,
    host,
    region: "us-east-1",
    serviceTier: "default",
  };
}

function observation(
  providerId: string,
  values: { p95Ms?: Measured; cost?: Measured; successRate?: Measured },
): ProviderObservation {
  return {
    providerId,
    p95Ms: values.p95Ms ?? INSUFFICIENT_DATA,
    costPer1kTokensUsd: values.cost ?? INSUFFICIENT_DATA,
    successRate: values.successRate ?? INSUFFICIENT_DATA,
    windowSpanMs: 60_000,
    sampleCount: 200,
  };
}

function workload(overrides: Partial<Workload> = {}): Workload {
  const dimensions = overrides.dimensions ?? {};
  return {
    name: "default",
    allowedModels: [{ model: "gpt-x", host: null }],
    dimensions,
    declarationOrder: Object.keys(dimensions) as DimensionName[],
    objective: "none",
    priority: (Object.keys(dimensions) as DimensionName[]).slice().reverse(),
    hard: null,
    ...overrides,
  };
}

function stateOf(
  providers: readonly Provider[],
  observations: readonly ProviderObservation[],
  target: Workload | null,
): ProviderState {
  return {
    providers,
    observations: Object.fromEntries(observations.map((entry) => [entry.providerId, entry])),
    workload: target,
  };
}

describe("the target's effect on the choice", () => {
  it("routes to the provider the stated target selects rather than the cheaper one", () => {
    const providers = [provider("fast"), provider("slow")];
    const observations = [
      observation("fast", { p95Ms: 400, cost: 9 }),
      observation("slow", { p95Ms: 3_000, cost: 1 }),
    ];

    const untargeted = chooseProvider(request, stateOf(providers, observations, null));
    assert.equal(
      untargeted.provider?.id,
      "slow",
      "with no target stated, the cheapest provider wins",
    );

    const targeted = chooseProvider(
      request,
      stateOf(providers, observations, workload({ dimensions: { p95_ms: 1_000 } })),
    );
    assert.equal(
      targeted.provider?.id,
      "fast",
      "a stated p95_ms ceiling must disqualify the cheap-but-slow provider and shift the choice",
    );
  });

  it("routes unbound when no workload states a target at all", () => {
    const decision = chooseProvider(
      request,
      stateOf([provider("only")], [observation("only", { cost: 2 })], null),
    );

    assert.equal(decision.provider?.id, "only");
    assert.equal(decision.boundBy, null, "with no target there is no dimension to bind the choice");
    assert.equal(decision.yielded, null);
    assert.equal(decision.failedHard, null);
    assert.deepEqual(decision.rejected, [], "an unbound decision rejects nobody");
  });
});

describe("absent measurement", () => {
  it("does not disqualify a provider that has no measured value for a stated dimension", () => {
    const decision = chooseProvider(
      request,
      stateOf(
        [provider("unmeasured")],
        [observation("unmeasured", { p95Ms: INSUFFICIENT_DATA, cost: 5 })],
        workload({ dimensions: { p95_ms: 100 } }),
      ),
    );

    assert.equal(
      decision.provider?.id,
      "unmeasured",
      "insufficient_data cannot show a breach, so it must never disqualify",
    );
    assert.equal(decision.failedHard, null);
    assert.equal(decision.yielded, null, "nothing had to yield: the target was not shown to fail");
  });

  it("explores a provider with no objective value ahead of a measured one", () => {
    const decision = chooseProvider(
      request,
      stateOf(
        [provider("blind"), provider("measured")],
        [
          observation("blind", { cost: INSUFFICIENT_DATA }),
          observation("measured", { cost: 42 }),
        ],
        workload({ objective: "cost_per_1k_tokens_usd" }),
      ),
    );

    assert.equal(
      decision.provider?.id,
      "blind",
      "an unmeasured provider must be explored ahead of a measured one: preferring what we " +
        "have already measured closes a loop in which a provider that is never chosen can " +
        "never be measured and a provider that can never be measured can never be chosen",
    );
  });

  it("does not let a measured provider beat an unmeasured one merely by having a number", () => {
    // The measured provider here is *better* on the objective than anything the unmeasured
    // one is likely to be. It still loses, and that is the point: the comparison is not
    // trustworthy until both sides have evidence, and the only way to get the missing half
    // is to send it traffic. Exploration is bounded — once `blind` clears the sample floor
    // it becomes measured and competes on its merits.
    const decision = chooseProvider(
      request,
      stateOf(
        [provider("blind"), provider("excellent")],
        [observation("blind", {}), observation("excellent", { cost: 0.01 })],
        workload({ objective: "cost_per_1k_tokens_usd" }),
      ),
    );

    assert.equal(
      decision.provider?.id,
      "blind",
      "a measured value does not win by default; gathering the missing evidence is the objective",
    );

    const rejection = decision.rejected.find((entry) => entry.providerId === "excellent");
    assert.ok(rejection, "the provider passed over for exploration must still be explained");
    assert.match(
      rejection.reason,
      /no measured/,
      "the report must say it lost to exploration, not to a number it could not have beaten",
    );
  });

  it("breaks a tie between two unmeasured providers by id so processes agree", () => {
    const observations = [observation("beta", {}), observation("alpha", {})];
    const forward = chooseProvider(
      request,
      stateOf([provider("beta"), provider("alpha")], observations, workload()),
    );
    const reversed = chooseProvider(
      request,
      stateOf([provider("alpha"), provider("beta")], observations, workload()),
    );

    assert.equal(forward.provider?.id, "alpha", "two unmeasured providers still tie-break on id");
    assert.equal(
      reversed.provider?.id,
      forward.provider?.id,
      "exploration must not make the decision depend on snapshot ordering",
    );
  });

  it("still chooses an unmeasured provider when it is the only survivor", () => {
    const decision = chooseProvider(
      request,
      stateOf(
        [provider("blind")],
        [observation("blind", {})],
        workload({ objective: "cost_per_1k_tokens_usd" }),
      ),
    );

    assert.equal(decision.provider?.id, "blind");
  });

  it("keeps absent evidence from disqualifying even while it is being explored", () => {
    // The two rules are separate and both hold: absent evidence never convicts a provider
    // on a ceiling, and absent evidence is worth going out and collecting.
    const decision = chooseProvider(
      request,
      stateOf(
        [provider("blind"), provider("slow")],
        [observation("blind", {}), observation("slow", { p95Ms: 9_000, cost: 1 })],
        workload({ dimensions: { p95_ms: 500 } }),
      ),
    );

    assert.equal(decision.provider?.id, "blind", "the only candidate not shown to breach wins");
    assert.equal(decision.yielded, null, "an unmeasured provider satisfying the ceiling is no concession");
    assert.equal(decision.failedHard, null);
  });
});

describe("the candidate set", () => {
  it("rejects a provider outside allowed_models with a stated reason", () => {
    const decision = chooseProvider(
      request,
      stateOf(
        [provider("allowed"), provider("other", "llama-y", "bedrock")],
        [observation("allowed", { cost: 3 }), observation("other", { cost: 1 })],
        workload(),
      ),
    );

    assert.equal(decision.provider?.id, "allowed", "a provider outside the blast radius cannot win");

    const rejection = decision.rejected.find((entry) => entry.providerId === "other");
    assert.ok(rejection, "every excluded candidate must appear in the report");
    assert.equal(
      rejection.dimension,
      null,
      "an allowed_models exclusion is not a dimension breach, so its dimension is null",
    );
    assert.match(rejection.reason, /allowed_models/);
  });

  it("throws rather than inventing a fallback when the snapshot carries no candidates", () => {
    // An empty provider list is a defect in the snapshot, not a policy outcome; the
    // fail-open wrapper in server.ts owns what happens next.
    assert.throws(() => chooseProvider(request, stateOf([], [], workload())));
  });
});

describe("the objective", () => {
  it("picks the minimizer of the stated objective", () => {
    const decision = chooseProvider(
      request,
      stateOf(
        [provider("quick"), provider("cheap")],
        [
          observation("quick", { p95Ms: 200, cost: 10 }),
          observation("cheap", { p95Ms: 900, cost: 1 }),
        ],
        workload({ dimensions: { p95_ms: 1_000 }, objective: "p95_ms" }),
      ),
    );

    assert.equal(decision.provider?.id, "quick", "the objective minimizes p95_ms, not cost");
    assert.equal(
      decision.boundBy,
      "p95_ms",
      "boundBy names the objective when the objective is what separated the survivors",
    );
  });

  it("holds the cheapest satisfying mix when the objective is none", () => {
    const decision = chooseProvider(
      request,
      stateOf(
        [provider("quick"), provider("cheap")],
        [
          observation("quick", { p95Ms: 200, cost: 10 }),
          observation("cheap", { p95Ms: 900, cost: 1 }),
        ],
        workload({ dimensions: { p95_ms: 1_000 }, objective: "none" }),
      ),
    );

    assert.equal(
      decision.provider?.id,
      "cheap",
      "with no objective stated the cheapest satisfying provider wins",
    );
  });

  it("breaks an exact tie on provider id so two processes reach the same decision", () => {
    const observations = [observation("beta", { cost: 5 }), observation("alpha", { cost: 5 })];
    const forward = chooseProvider(
      request,
      stateOf([provider("beta"), provider("alpha")], observations, workload()),
    );
    const reversed = chooseProvider(
      request,
      stateOf([provider("alpha"), provider("beta")], observations, workload()),
    );

    assert.equal(forward.provider?.id, "alpha", "an exact tie breaks on the lower provider id");
    assert.equal(
      reversed.provider?.id,
      forward.provider?.id,
      "the decision must not depend on the order the snapshot happened to list providers in",
    );
  });

  it("gives every candidate that did not win a reason", () => {
    const decision = chooseProvider(
      request,
      stateOf(
        [provider("winner"), provider("loser"), provider("breacher")],
        [
          observation("winner", { p95Ms: 100, cost: 1 }),
          observation("loser", { p95Ms: 200, cost: 4 }),
          observation("breacher", { p95Ms: 9_000, cost: 0.5 }),
        ],
        workload({ dimensions: { p95_ms: 1_000 } }),
      ),
    );

    assert.equal(decision.provider?.id, "winner");
    for (const id of ["loser", "breacher"]) {
      const rejection = decision.rejected.find((entry) => entry.providerId === id);
      assert.ok(rejection, `every candidate that was not chosen must carry a reason (${id})`);
      assert.notEqual(rejection.reason, "", "a reason must be human-readable, not empty");
      assert.equal(rejection.providerId, id);
    }

    const breach = decision.rejected.find((entry) => entry.providerId === "breacher");
    assert.equal(breach?.dimension, "p95_ms", "a breach names the dimension at fault");
    assert.equal(breach?.observed, 9_000, "a breach carries the observed value it rests on");
    assert.equal(breach?.target, 1_000, "a breach carries the target it was measured against");
  });
});

describe("relaxation when no provider holds every ceiling", () => {
  // p95_ms is declared first and so outranks cost; cost is the last entry in `priority`
  // and is therefore the ceiling that yields first.
  const conflicting = {
    dimensions: { p95_ms: 500, cost_per_1k_tokens_usd: 1 },
    priority: ["p95_ms", "cost_per_1k_tokens_usd"] as DimensionName[],
    declarationOrder: ["p95_ms", "cost_per_1k_tokens_usd"] as DimensionName[],
  };

  const providers = [provider("fast-pricey"), provider("slow-cheap")];
  const observations = [
    observation("fast-pricey", { p95Ms: 200, cost: 20 }),
    observation("slow-cheap", { p95Ms: 5_000, cost: 0.5 }),
  ];

  it("yields the lowest-priority ceiling and reports which one gave way", () => {
    const decision = chooseProvider(
      request,
      stateOf(providers, observations, workload(conflicting)),
    );

    assert.equal(
      decision.yielded,
      "cost_per_1k_tokens_usd",
      "priority is highest-first, so the last entry is the ceiling that yields first",
    );
    assert.equal(
      decision.provider?.id,
      "fast-pricey",
      "the higher-priority p95_ms ceiling must still hold after cost yields",
    );
    assert.equal(decision.failedHard, null, "yielding is a concession, not a failure");
  });

  it("fails the request instead of breaching a dimension marked hard", () => {
    const decision = chooseProvider(
      request,
      stateOf(
        providers,
        observations,
        workload({ ...conflicting, hard: "cost_per_1k_tokens_usd" }),
      ),
    );

    assert.equal(
      decision.provider,
      null,
      "a hard dimension never yields: the request fails rather than being served in breach",
    );
    assert.equal(decision.failedHard, "cost_per_1k_tokens_usd");
    assert.equal(
      decision.rejected.length,
      providers.length,
      "an infeasible request must explain every candidate it could not use",
    );
    for (const entry of decision.rejected) {
      assert.notEqual(entry.reason, "", "infeasibility is data, and the data includes the why");
    }
  });

  it("reports infeasibility as a return value rather than throwing", () => {
    assert.doesNotThrow(() =>
      chooseProvider(
        request,
        stateOf(providers, observations, workload({ ...conflicting, hard: "p95_ms" })),
      ),
    );
  });
});
