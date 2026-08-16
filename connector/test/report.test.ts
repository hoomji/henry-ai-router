import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createReporter, isStrainEvidence } from "../src/report.js";
import type { UsageBatch } from "../src/report.js";
import { close, listen, readBody, serve, usageRecord } from "./helpers.js";

function capture(): { batches: UsageBatch[]; send: (batch: UsageBatch) => Promise<void> } {
  const batches: UsageBatch[] = [];
  return {
    batches,
    send: async (batch: UsageBatch): Promise<void> => {
      batches.push(batch);
    },
  };
}

const base = { gatewayUrl: "http://unused.invalid", connectorToken: "t" };

describe("usage batching", () => {
  it("flushes at the hundredth record without waiting for the interval", async () => {
    const sink = capture();
    const reporter = createReporter({ ...base, send: sink.send, flushIntervalMs: 60_000 });

    try {
      for (let n = 0; n < 99; n += 1) reporter.record(usageRecord({ atMs: n }));
      assert.equal(sink.batches.length, 0, "ninety-nine is not a hundred");

      reporter.record(usageRecord({ atMs: 99 }));
      await reporter.flush();

      assert.equal(sink.batches.length, 1);
      assert.equal(sink.batches[0]?.records.length, 100);
    } finally {
      reporter.close();
    }
  });

  it("flushes on the interval when the count threshold is never reached", async () => {
    const sink = capture();
    const reporter = createReporter({ ...base, send: sink.send, flushIntervalMs: 20 });

    try {
      reporter.record(usageRecord({}));
      await new Promise((done) => setTimeout(done, 80));
      assert.ok(sink.batches.length >= 1, "a single record must not wait for ninety-nine more");
    } finally {
      reporter.close();
    }
  });

  it("never surfaces a failed report to the caller", async () => {
    const reporter = createReporter({
      ...base,
      flushIntervalMs: 60_000,
      send: (): Promise<void> => Promise.reject(new Error("gateway is down")),
    });

    try {
      reporter.record(usageRecord({}));
      await reporter.flush();
      // Reaching here at all is the assertion: a rejected send resolves quietly, and the
      // buffer is cleared rather than growing inside the customer's process.
      assert.equal(reporter.stats().usageBuffered, 0);
    } finally {
      reporter.close();
    }
  });

  it("posts the batch to the gateway's usage endpoint by default", async () => {
    const seen: { batch: UsageBatch | null; authorization: string | undefined } = {
      batch: null,
      authorization: undefined,
    };
    const gateway = serve((req, res) => {
      seen.authorization = req.headers.authorization;
      void readBody(req).then((body) => {
        seen.batch = JSON.parse(body) as UsageBatch;
        res.writeHead(204).end();
      });
    });
    const url = await listen(gateway);

    const reporter = createReporter({ gatewayUrl: url, connectorToken: "secret", flushIntervalMs: 60_000 });
    try {
      reporter.record(usageRecord({ providerId: "sim-a" }));
      await reporter.flush();

      assert.equal(seen.authorization, "Bearer secret");
      assert.equal(seen.batch?.records[0]?.providerId, "sim-a");
    } finally {
      reporter.close();
      await close(gateway);
    }
  });
});

/**
 * The asymmetry is the point.
 *
 * These two tests are the reason `report.ts` holds two buffers rather than one. Drop-oldest
 * is right for a bill and wrong for a burst; making both buffers behave the same way would
 * be the tidier code and the wrong system.
 */
describe("the two shedding policies", () => {
  it("drops the OLDEST usage record when the usage buffer is full", async () => {
    const sink = capture();
    const reporter = createReporter({
      ...base,
      send: sink.send,
      flushIntervalMs: 60_000,
      flushAtRecords: 1_000,
      usageCapacity: 3,
      strainCapacity: 3,
    });

    try {
      for (let n = 0; n < 5; n += 1) reporter.record(usageRecord({ atMs: n }));
      await reporter.flush();

      assert.deepEqual(
        sink.batches[0]?.records.map((record) => record.atMs),
        [2, 3, 4],
        "the newest three survive; the bill's recent minutes are what a customer checks",
      );
      assert.equal(sink.batches[0]?.usageDropped, 2);
    } finally {
      reporter.close();
    }
  });

  it("sheds strain evidence by SAMPLING, keeping the burst's onset and counting the drops", async () => {
    const sink = capture();
    const reporter = createReporter({
      ...base,
      send: sink.send,
      flushIntervalMs: 60_000,
      flushAtRecords: 1_000,
      usageCapacity: 2,
      strainCapacity: 3,
      // Reservoir sampling with the draw pinned to the top of the range: every incoming
      // record loses the coin flip, so the retained sample is the burst's first three.
      // Under drop-oldest the same input would retain the last three — the tail of the
      // storm, with its onset thrown away.
      random: (): number => 1,
    });

    try {
      for (let n = 0; n < 20; n += 1) {
        reporter.record(usageRecord({ atMs: n, statusCode: 429, rateLimitLimit: "500" }));
      }

      assert.equal(reporter.stats().strainBuffered, 3);
      await reporter.flush();

      const batch = sink.batches[0];
      const strainAtMs = (batch?.records ?? []).map((record) => record.atMs).sort((a, b) => a - b);

      assert.ok(strainAtMs.includes(0), "the onset of the burst must survive shedding");
      assert.ok(strainAtMs.includes(1) && strainAtMs.includes(2));
      assert.equal(batch?.strainDropped, 17, "the aggregate must know what it is missing");
      assert.equal(batch?.usageDropped, 18);
    } finally {
      reporter.close();
    }
  });

  it("sends a shed strain record exactly once even though it is also a usage record", async () => {
    const sink = capture();
    const reporter = createReporter({
      ...base,
      send: sink.send,
      flushIntervalMs: 60_000,
      flushAtRecords: 1_000,
      usageCapacity: 10,
      strainCapacity: 10,
    });

    try {
      reporter.record(usageRecord({ atMs: 1, statusCode: 503 }));
      await reporter.flush();

      assert.equal(sink.batches[0]?.records.length, 1);
    } finally {
      reporter.close();
    }
  });
});

describe("what counts as strain evidence", () => {
  it("treats a transport failure, a 429 and a 5xx alike, and a clean 200 not at all", () => {
    assert.equal(isStrainEvidence(usageRecord({ statusCode: 0 })), true);
    assert.equal(isStrainEvidence(usageRecord({ statusCode: 429 })), true);
    assert.equal(isStrainEvidence(usageRecord({ statusCode: 503 })), true);
    assert.equal(isStrainEvidence(usageRecord({ statusCode: 200 })), false);
  });

  it("counts a 200 carrying rate-limit headers, which is an approaching ceiling", () => {
    assert.equal(
      isStrainEvidence(usageRecord({ statusCode: 200, rateLimitReset: "30" })),
      true,
    );
  });
});
