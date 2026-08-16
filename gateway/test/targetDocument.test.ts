import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  TargetDocumentError,
  parseAllowedModel,
  parseTargetDocument,
  providerMatchesAllowed,
  serializeTargetDocument,
} from "../src/targets/document.js";
import type { Provider } from "../src/types.js";

/** A minimal accepted document, spread into the cases that vary one thing about it. */
function doc(workload: Record<string, unknown>): Record<string, unknown> {
  return { workloads: { default: { allowed_models: ["gpt-4o"], ...workload } } };
}

function parse(raw: unknown) {
  return parseTargetDocument(raw, 7);
}

function provider(model: string, host: string): Provider {
  return {
    id: `${model}@${host}`,
    baseUrl: "http://example.invalid",
    model,
    host,
    region: "us-east-1",
    serviceTier: "standard",
  };
}

describe("the closed dimension vocabulary", () => {
  it("accepts the three dimensions and records the order they were declared in", () => {
    const document = parse(
      doc({ success_rate: 0.99, p95_ms: 900, cost_per_1k_tokens_usd: 0.01 }),
    );
    const workload = document.workloads["default"];

    assert.deepEqual(
      workload?.declarationOrder,
      ["success_rate", "p95_ms", "cost_per_1k_tokens_usd"],
      "declaration order is the key order of the workload object, filtered to dimensions",
    );
    assert.deepEqual(workload?.dimensions, {
      success_rate: 0.99,
      p95_ms: 900,
      cost_per_1k_tokens_usd: 0.01,
    });
  });

  it("rejects an unknown key inside a workload rather than ignoring it", () => {
    assert.throws(
      () => parse(doc({ rate_limit_headroom: 5 })),
      (error: unknown) =>
        error instanceof TargetDocumentError && error.detail === "default.rate_limit_headroom",
      "the vocabulary is closed, so a dimension we cannot measure must fail the write",
    );
  });

  it("accepts a workload that states no dimension at all", () => {
    const workload = parse(doc({})).workloads["default"];

    assert.deepEqual(workload?.declarationOrder, []);
    assert.deepEqual(workload?.priority, []);
    assert.equal(workload?.objective, "none");
    assert.equal(workload?.hard, null);
  });
});

describe("dimension values", () => {
  it("rejects a value that is not a number", () => {
    assert.throws(() => parse(doc({ p95_ms: "900" })), TargetDocumentError);
  });

  it("rejects NaN", () => {
    assert.throws(() => parse(doc({ p95_ms: Number.NaN })), TargetDocumentError);
  });

  it("rejects a negative or zero value", () => {
    assert.throws(() => parse(doc({ p95_ms: -1 })), TargetDocumentError);
    assert.throws(() => parse(doc({ p95_ms: 0 })), TargetDocumentError);
  });

  it("rejects a success_rate above 1 because a share above 1 is not a share", () => {
    assert.throws(() => parse(doc({ success_rate: 1.5 })), TargetDocumentError);
    assert.equal(
      parse(doc({ success_rate: 1 })).workloads["default"]?.dimensions.success_rate,
      1,
      "exactly 1 is a legitimate floor",
    );
  });
});

describe("allowed_models", () => {
  it("reads a bare entry as any host and a qualified entry as a pin", () => {
    assert.deepEqual(parseAllowedModel("gpt-4o"), { model: "gpt-4o", host: null });
    assert.deepEqual(parseAllowedModel("claude-sonnet-4.5@bedrock"), {
      model: "claude-sonnet-4.5",
      host: "bedrock",
    });
  });

  it("rejects an empty entry, a doubled host, and an empty half", () => {
    assert.throws(() => parseAllowedModel(""), TargetDocumentError);
    assert.throws(() => parseAllowedModel("gpt-4o@a@b"), TargetDocumentError);
    assert.throws(() => parseAllowedModel("@bedrock"), TargetDocumentError);
    assert.throws(() => parseAllowedModel("gpt-4o@"), TargetDocumentError);
  });

  it("rejects a workload with no allowed_models", () => {
    assert.throws(
      () => parseTargetDocument({ workloads: { default: { p95_ms: 900 } } }, 1),
      TargetDocumentError,
      "allowed_models is what bounds the candidate set the feasibility check runs over",
    );
  });

  it("rejects an empty allowed_models list", () => {
    assert.throws(
      () => parseTargetDocument({ workloads: { default: { allowed_models: [] } } }, 1),
      TargetDocumentError,
    );
  });

  it("rejects a non-list and a non-string entry", () => {
    assert.throws(
      () => parseTargetDocument({ workloads: { default: { allowed_models: "gpt-4o" } } }, 1),
      TargetDocumentError,
    );
    assert.throws(
      () => parseTargetDocument({ workloads: { default: { allowed_models: [42] } } }, 1),
      TargetDocumentError,
    );
  });
});

describe("providerMatchesAllowed", () => {
  const bare = [{ model: "gpt-4o", host: null }];
  const pinned = [{ model: "claude-sonnet-4.5", host: "bedrock" }];

  it("matches any host for a bare entry", () => {
    assert.equal(providerMatchesAllowed(provider("gpt-4o", "openai"), bare), true);
    assert.equal(providerMatchesAllowed(provider("gpt-4o", "azure"), bare), true);
  });

  it("matches only the pinned host for a qualified entry", () => {
    assert.equal(providerMatchesAllowed(provider("claude-sonnet-4.5", "bedrock"), pinned), true);
    assert.equal(
      providerMatchesAllowed(provider("claude-sonnet-4.5", "anthropic"), pinned),
      false,
      "the same model on two hosts measured an 86% p50 spread, so a pin is load-bearing (#11)",
    );
  });

  it("never matches a model outside the list", () => {
    assert.equal(providerMatchesAllowed(provider("gpt-4o-mini", "openai"), bare), false);
  });
});

describe("priority", () => {
  it("defaults to the reverse of the declaration order", () => {
    const workload = parse(doc({ p95_ms: 900, success_rate: 0.99 })).workloads["default"];

    assert.deepEqual(
      workload?.priority,
      ["success_rate", "p95_ms"],
      "highest priority first, so the ceiling declared last is the one that yields first",
    );
  });

  it("accepts a stated permutation of the stated dimensions", () => {
    const workload = parse(
      doc({ p95_ms: 900, success_rate: 0.99, priority: ["p95_ms", "success_rate"] }),
    ).workloads["default"];

    assert.deepEqual(workload?.priority, ["p95_ms", "success_rate"]);
  });

  it("rejects a priority naming an unknown dimension", () => {
    assert.throws(
      () => parse(doc({ p95_ms: 900, priority: ["latency"] })),
      TargetDocumentError,
    );
  });

  it("rejects a priority naming a dimension the workload does not state", () => {
    assert.throws(
      () => parse(doc({ p95_ms: 900, priority: ["p95_ms", "success_rate"] })),
      TargetDocumentError,
    );
  });

  it("rejects a priority that omits a stated dimension", () => {
    assert.throws(
      () => parse(doc({ p95_ms: 900, success_rate: 0.99, priority: ["p95_ms"] })),
      TargetDocumentError,
      "a partial order leaves undetermined which ceiling yields first",
    );
  });

  it("rejects a duplicated entry", () => {
    assert.throws(
      () => parse(doc({ p95_ms: 900, priority: ["p95_ms", "p95_ms"] })),
      TargetDocumentError,
    );
  });

  it("rejects a priority that is not a list", () => {
    assert.throws(() => parse(doc({ p95_ms: 900, priority: "p95_ms" })), TargetDocumentError);
  });
});

describe("objective and hard", () => {
  it("defaults the objective to none and hard to null", () => {
    const workload = parse(doc({ p95_ms: 900 })).workloads["default"];

    assert.equal(workload?.objective, "none");
    assert.equal(workload?.hard, null);
  });

  it("accepts a stated dimension as the objective", () => {
    const workload = parse(
      doc({ cost_per_1k_tokens_usd: 0.01, objective: "cost_per_1k_tokens_usd" }),
    ).workloads["default"];

    assert.equal(workload?.objective, "cost_per_1k_tokens_usd");
  });

  it("accepts an objective the workload states no ceiling for", () => {
    const workload = parse(
      doc({ p95_ms: 900, objective: "cost_per_1k_tokens_usd" }),
    ).workloads["default"];

    assert.equal(
      workload?.objective,
      "cost_per_1k_tokens_usd",
      "\"hold p95 under 900ms and minimize cost\" is the canonical target behavior 1 serves; " +
        "the objective is what is added on top of the ceilings, so it need not be one of them",
    );
    assert.deepEqual(
      workload?.declarationOrder,
      ["p95_ms"],
      "an objective states no ceiling, so it never joins the declaration order",
    );
    assert.deepEqual(
      workload?.priority,
      ["p95_ms"],
      "nothing yields for an unstated ceiling: the objective is absent from the priority order",
    );
  });

  it("rejects an objective outside the vocabulary", () => {
    assert.throws(() => parse(doc({ p95_ms: 900, objective: "quality" })), TargetDocumentError);
  });

  it("accepts a hard dimension the workload states", () => {
    const workload = parse(
      doc({ success_rate: 0.99, hard: "success_rate" }),
    ).workloads["default"];

    assert.equal(workload?.hard, "success_rate");
  });

  it("rejects a hard dimension the workload does not state", () => {
    assert.throws(() => parse(doc({ p95_ms: 900, hard: "success_rate" })), TargetDocumentError);
  });

  it("accepts an explicit null hard", () => {
    assert.equal(parse(doc({ p95_ms: 900, hard: null })).workloads["default"]?.hard, null);
  });
});

describe("the document envelope", () => {
  it("rejects a document that is not an object", () => {
    assert.throws(() => parse("nope"), TargetDocumentError);
    assert.throws(() => parse(null), TargetDocumentError);
    assert.throws(() => parse([]), TargetDocumentError);
  });

  it("rejects a missing or empty workloads map", () => {
    assert.throws(() => parse({}), TargetDocumentError);
    assert.throws(() => parse({ workloads: {} }), TargetDocumentError);
  });

  it("rejects a document with no default workload", () => {
    assert.throws(
      () => parse({ workloads: { batch: { allowed_models: ["gpt-4o"] } } }),
      TargetDocumentError,
      "requests that name no workload fall to default, so a document without one is unroutable",
    );
  });

  it("rejects an empty workload name", () => {
    assert.throws(
      () =>
        parse({
          workloads: { "": { allowed_models: ["gpt-4o"] }, default: { allowed_models: ["gpt-4o"] } },
        }),
      TargetDocumentError,
    );
  });

  it("rejects a workload that is not an object", () => {
    assert.throws(() => parse({ workloads: { default: 42 } }), TargetDocumentError);
  });

  it("rejects an unknown top-level key", () => {
    assert.throws(() => parse({ ...doc({}), retention_days: 30 }), TargetDocumentError);
  });

  it("defaults notify_url to null and accepts an http or https URL", () => {
    assert.equal(parse(doc({})).notifyUrl, null);
    assert.equal(
      parseTargetDocument({ ...doc({}), notify_url: "https://example.invalid/hook" }, 1).notifyUrl,
      "https://example.invalid/hook",
    );
  });

  it("rejects a notify_url that is not a postable URL", () => {
    assert.throws(
      () => parseTargetDocument({ ...doc({}), notify_url: "not-a-url" }, 1),
      TargetDocumentError,
    );
  });

  it("takes its version from the store rather than the wire", () => {
    assert.equal(
      parseTargetDocument({ ...doc({}), version: 99 }, 7).version,
      7,
      "the store decides what version a document is; a writer's claim belongs to the CAS",
    );
  });
});

describe("the round trip", () => {
  it("preserves every workload, including declaration order and a defaulted priority", () => {
    const original = parseTargetDocument(
      {
        notify_url: "https://example.invalid/hook",
        workloads: {
          default: {
            allowed_models: ["gpt-4o", "claude-sonnet-4.5@bedrock"],
            p95_ms: 900,
            cost_per_1k_tokens_usd: 0.01,
            objective: "cost_per_1k_tokens_usd",
            hard: "p95_ms",
          },
          batch: {
            allowed_models: ["claude-sonnet-4.5"],
            success_rate: 0.99,
            p95_ms: 60000,
            priority: ["p95_ms", "success_rate"],
          },
        },
      },
      3,
    );

    const round = parseTargetDocument(serializeTargetDocument(original), original.version);

    assert.deepEqual(round, original, "serialize must lose nothing a re-parse depends on");
    assert.deepEqual(
      round.workloads["default"]?.priority,
      ["cost_per_1k_tokens_usd", "p95_ms"],
      "a defaulted priority is emitted explicitly, so a reordered map cannot change what yields",
    );
  });
});
