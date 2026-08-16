import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_WINDOW_CONFIG,
  RollingWindows,
  mergeObservations,
  percentile,
} from "../src/routing/stats.js";
import { INSUFFICIENT_DATA } from "../src/types.js";
import type { RequestOutcome, WindowSummary } from "../src/types.js";

const T0 = 1_000_000;

function outcome(overrides: Partial<RequestOutcome> = {}): RequestOutcome {
  return {
    workload: "default",
    providerId: "p1",
    latencyMs: 100,
    costPer1kTokensUsd: 0.01,
    success: true,
    malformed: false,
    atMs: T0,
    ...overrides,
  };
}

/** Feed `count` requests into `windows`, one per millisecond from `startMs`. */
function feed(
  windows: RollingWindows,
  count: number,
  overrides: Partial<RequestOutcome> = {},
  startMs = T0,
): void {
  for (let i = 0; i < count; i += 1) {
    windows.record(outcome({ atMs: startMs + i, ...overrides }));
  }
}

describe("the window close condition", () => {
  it("does not close a window that has spanned five minutes but seen only three requests", () => {
    const windows = new RollingWindows("proc-a");
    feed(windows, 3);

    assert.deepEqual(
      windows.closeDue(T0 + DEFAULT_WINDOW_CONFIG.spanMs + 1),
      [],
      "the window is 5 minutes OR 200 requests whichever spans LONGER, so elapsed time alone must not close it",
    );
  });

  it("does not close a window that has seen 200 requests but only spanned ten seconds", () => {
    const windows = new RollingWindows("proc-a");
    feed(windows, DEFAULT_WINDOW_CONFIG.minRequests);

    assert.deepEqual(
      windows.closeDue(T0 + 10_000),
      [],
      "reaching the request count early must not close a window before the trailing span is covered",
    );
  });

  it("closes the window once both the span and the request count are satisfied", () => {
    const windows = new RollingWindows("proc-a");
    feed(windows, DEFAULT_WINDOW_CONFIG.minRequests);

    const closedAtMs = T0 + DEFAULT_WINDOW_CONFIG.spanMs;
    const summaries = windows.closeDue(closedAtMs);

    assert.equal(summaries.length, 1, "both conditions hold, so exactly one window is due");
    const summary = summaries[0];
    assert.ok(summary !== undefined);
    assert.equal(summary.requestCount, 200, "every recorded request belongs to the window it closed");
    assert.equal(summary.openedAtMs, T0, "a window opens at the first request folded into it");
    assert.equal(summary.closedAtMs, closedAtMs, "a window closes at the time the caller supplied, never at a clock read");
    assert.equal(summary.processId, "proc-a", "a summary names its writing process so a dead process's rows can age out");

    assert.deepEqual(
      windows.closeDue(closedAtMs + DEFAULT_WINDOW_CONFIG.spanMs),
      [],
      "a closed window is gone; closing must not emit the same samples twice",
    );
  });
});

describe("what a window counts", () => {
  it("excludes malformed outcomes from the denominator entirely", () => {
    const config = { spanMs: 1_000, minRequests: 4, sampleFloor: 1 };

    const clean = new RollingWindows("proc-a", config);
    feed(clean, 4);
    const cleanSummary = clean.closeAll(T0 + 1_000)[0];
    assert.ok(cleanSummary !== undefined);

    const withMalformed = new RollingWindows("proc-a", config);
    feed(withMalformed, 4);
    withMalformed.record(outcome({ success: false, malformed: true, atMs: T0 + 5 }));
    const malformedSummary = withMalformed.closeAll(T0 + 1_000)[0];
    assert.ok(malformedSummary !== undefined);

    assert.equal(
      malformedSummary.requestCount,
      cleanSummary.requestCount,
      "a malformed customer request is not provider risk: it must not enter the denominator",
    );
    assert.equal(
      malformedSummary.successCount,
      cleanSummary.successCount,
      "nor the numerator — a malformed request is dropped, not counted as a failure",
    );

    const observations = mergeObservations([malformedSummary], config.sampleFloor);
    assert.equal(
      observations["p1"]?.successRate,
      1,
      "success_rate must be unaffected by adding a malformed failure",
    );
  });

  it("counts a re-routed failure as a success because the caller judged it usable", () => {
    const config = { spanMs: 1_000, minRequests: 2, sampleFloor: 1 };
    const windows = new RollingWindows("proc-a", config);
    windows.record(outcome({ success: true }));
    windows.record(outcome({ success: false, atMs: T0 + 1 }));

    const summary = windows.closeAll(T0 + 1_000)[0];
    assert.ok(summary !== undefined);
    assert.equal(
      summary.successCount,
      1,
      "success is the caller's judgment after retries and failovers; measurement must not re-derive it",
    );
  });

  it("keeps windows per (workload, provider) pair", () => {
    const config = { spanMs: 1_000, minRequests: 1, sampleFloor: 1 };
    const windows = new RollingWindows("proc-a", config);
    windows.record(outcome({ workload: "chat", providerId: "p1", latencyMs: 10 }));
    windows.record(outcome({ workload: "batch", providerId: "p1", latencyMs: 20, atMs: T0 + 1 }));
    windows.record(outcome({ workload: "chat", providerId: "p2", latencyMs: 30, atMs: T0 + 2 }));

    const summaries = windows.closeAll(T0 + 1_000);
    assert.equal(summaries.length, 3, "each (workload, provider) pair is measured separately, since each is held to its own target");

    const chatP1 = summaries.find((s) => s.workload === "chat" && s.providerId === "p1");
    assert.deepEqual(
      chatP1?.latenciesMs,
      [10],
      "one workload's traffic must never leak into another workload's measurement of the same provider",
    );
  });

  it("reports whether a workload has in-flight samples", () => {
    const windows = new RollingWindows("proc-a");
    assert.equal(windows.open("chat"), false, "a workload with no traffic has nothing in flight");

    windows.record(outcome({ workload: "chat" }));
    assert.equal(windows.open("chat"), true, "a recorded request is in flight until its window is written out");
    assert.equal(windows.open("batch"), false, "in-flight state is per workload");

    windows.closeAll(T0 + 1);
    assert.equal(windows.open("chat"), false, "closing flushes the samples, so nothing remains in flight");
  });

  it("flushes every in-flight window on closeAll even when none is due", () => {
    const windows = new RollingWindows("proc-a");
    feed(windows, 3);

    const summaries = windows.closeAll(T0 + 5);
    assert.equal(
      summaries.length,
      1,
      "shutdown must not silently discard measurement; a partial window is better evidence than none",
    );
    assert.equal(summaries[0]?.requestCount, 3, "closeAll carries the partial counts through unchanged");
  });
});

describe("the sample floor", () => {
  it("reports insufficient_data for all three dimensions below the floor", () => {
    const summary = summaryOf({ requestCount: 19, successCount: 19, latenciesMs: [5, 6, 7] });

    const observation = mergeObservations([summary], 20)["p1"];
    assert.ok(observation !== undefined);
    assert.equal(observation.p95Ms, INSUFFICIENT_DATA, "a percentile over a handful of requests is never reported");
    assert.equal(observation.successRate, INSUFFICIENT_DATA, "a success rate below the floor is false confidence, not a measurement");
    assert.equal(observation.costPer1kTokensUsd, INSUFFICIENT_DATA, "the floor applies to every dimension, not only the percentile");
    assert.equal(observation.sampleCount, 19, "the sample count is reported even when no dimension can be");
  });

  it("reports real numbers once the floor is reached", () => {
    const latenciesMs = Array.from({ length: 20 }, (_unused, i) => (i + 1) * 10);
    const summary = summaryOf({
      requestCount: 20,
      successCount: 19,
      latenciesMs,
      costPer1kTokensUsdSum: 4,
    });

    const observation = mergeObservations([summary], 20)["p1"];
    assert.ok(observation !== undefined);
    assert.equal(observation.p95Ms, 190, "at exactly the floor the dimension is measured, not withheld");
    assert.equal(observation.successRate, 19 / 20, "success_rate is successCount / requestCount");
    assert.equal(observation.costPer1kTokensUsd, 0.2, "cost is the unit rate for the mix actually served: the cost sum over the requests");
  });
});

describe("merging summaries across processes", () => {
  it("clears a floor that neither process reached alone", () => {
    const a = summaryOf({
      processId: "proc-a",
      requestCount: 12,
      successCount: 12,
      latenciesMs: [10, 20, 30],
      openedAtMs: T0,
      closedAtMs: T0 + 60_000,
    });
    const b = summaryOf({
      processId: "proc-b",
      requestCount: 12,
      successCount: 11,
      latenciesMs: [40, 50, 60],
      openedAtMs: T0 - 30_000,
      closedAtMs: T0 + 90_000,
    });

    assert.equal(
      mergeObservations([a], 20)["p1"]?.successRate,
      INSUFFICIENT_DATA,
      "twelve requests in one process is below the floor",
    );

    const observation = mergeObservations([a, b], 20)["p1"];
    assert.ok(observation !== undefined);
    assert.equal(
      observation.sampleCount,
      24,
      "the sample floor is workload-wide across merged summaries, not per process (ADR 0002)",
    );
    assert.equal(observation.successRate, 23 / 24, "counts sum across processes before the rate is taken");
    assert.equal(
      observation.windowSpanMs,
      120_000,
      "the merged span runs from the earliest open to the latest close across the merged rows",
    );
  });

  it("merges latencies by concatenating and re-sorting rather than averaging percentiles", () => {
    const a = summaryOf({
      processId: "proc-a",
      requestCount: 10,
      successCount: 10,
      latenciesMs: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    });
    const b = summaryOf({
      processId: "proc-b",
      requestCount: 10,
      successCount: 10,
      latenciesMs: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
    });

    const observation = mergeObservations([a, b], 20)["p1"];
    assert.equal(
      observation?.p95Ms,
      19,
      "a percentile of percentiles is not a percentile: the merged p95 is taken over all 20 samples",
    );
  });

  it("keeps providers separate while merging", () => {
    const p1 = summaryOf({ providerId: "p1", requestCount: 20, successCount: 20, latenciesMs: [1] });
    const p2 = summaryOf({ providerId: "p2", requestCount: 20, successCount: 10, latenciesMs: [2] });

    const observations = mergeObservations([p1, p2], 20);
    assert.equal(observations["p1"]?.successRate, 1, "one provider's failures must not be charged to another");
    assert.equal(observations["p2"]?.successRate, 0.5, "each provider is observed on its own samples");
  });
});

describe("percentile", () => {
  it("takes the nearest rank so the reported value is one the gateway actually observed", () => {
    const sorted = Array.from({ length: 100 }, (_unused, i) => i + 1);
    assert.equal(percentile(sorted, 0.95), 95, "nearest-rank p95 of 1..100 is the 95th element");
    assert.equal(percentile(sorted, 0.5), 50, "nearest-rank p50 of 1..100 is the 50th element");
    assert.equal(percentile(sorted, 1), 100, "p100 is the largest observed sample");
  });

  it("returns the single element for a one-sample array", () => {
    assert.equal(percentile([42], 0.95), 42, "with one sample every percentile is that sample");
    assert.equal(percentile([42], 0), 42, "the rank is clamped into the array rather than going negative");
  });

  it("throws on an empty array because that is a caller defect", () => {
    assert.throws(
      () => percentile([], 0.95),
      /empty sample/,
      "a percentile over nothing is a bug at the call site: the floor must be checked first",
    );
  });
});

/** Build a `WindowSummary` with test-relevant fields named and the rest defaulted. */
function summaryOf(overrides: Partial<WindowSummary> = {}): WindowSummary {
  return {
    workload: "default",
    providerId: "p1",
    processId: "proc-a",
    openedAtMs: T0,
    closedAtMs: T0 + DEFAULT_WINDOW_CONFIG.spanMs,
    latenciesMs: [],
    successCount: 0,
    requestCount: 0,
    costPer1kTokensUsdSum: 0,
    ...overrides,
  };
}
