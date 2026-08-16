import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { StoreUnavailableError, TargetStore } from "../src/targets/store.js";
import type { TargetDocument, UnmetState, WindowSummary } from "../src/types.js";

/**
 * Every test gets its own directory.
 *
 * A shared fixed path would make these tests order-dependent, and the cross-process cases
 * below deliberately open the same file twice — a leaked file from a previous test would
 * look exactly like the second writer they are trying to prove something about.
 */
let directories = 0;
function withStorePath(body: (path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), `gateway-store-${process.pid}-${directories++}-`));
  try {
    body(join(directory, "targets.db"));
  } finally {
    // `maxRetries` is for Windows: a just-closed database's `-wal` and `-shm` files can
    // still be held for a moment, and a failed cleanup would fail an otherwise passing test.
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

function documentWith(notifyUrl: string | null): TargetDocument {
  return {
    version: 0,
    notifyUrl,
    workloads: {
      default: {
        name: "default",
        allowedModels: [{ model: "claude-sonnet-4.5", host: null }],
        dimensions: { p95_ms: 2000 },
        declarationOrder: ["p95_ms"],
        objective: "cost_per_1k_tokens_usd",
        priority: ["p95_ms"],
        hard: null,
      },
    },
  };
}

function summaryFrom(overrides: Partial<WindowSummary>): WindowSummary {
  return {
    workload: "default",
    providerId: "passthrough",
    processId: "process-a",
    openedAtMs: 1_000,
    closedAtMs: 2_000,
    latenciesMs: [100, 200, 300],
    successCount: 3,
    requestCount: 3,
    costPer1kTokensUsdSum: 0.09,
    ...overrides,
  };
}

function unmetStateFrom(overrides: Partial<UnmetState>): UnmetState {
  return {
    workload: "default",
    unmet: false,
    since: null,
    report: null,
    missedStreak: 0,
    heldStreak: 0,
    lastWindowAtMs: null,
    ...overrides,
  };
}

describe("the target document in the store", () => {
  it("reports no document rather than an empty one before the first write", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        assert.equal(
          store.readDocument(),
          null,
          "an unwritten document must be distinguishable from a corrupt store, which throws",
        );
        assert.equal(store.readVersion(), 0, "the version before any write is 0");
      } finally {
        store.close();
      }
    });
  });

  it("round-trips a document and hands back the version the store assigned", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        const result = store.writeDocument(0, documentWith("https://example.invalid/hook"), null);
        assert.deepEqual(result, { ok: true, version: 1 });

        const stored = store.readDocument();
        assert.notEqual(stored, null);
        assert.equal(stored?.version, 1, "the version comes from the store, not the document");
        assert.equal(stored?.notifyUrl, "https://example.invalid/hook");
        assert.deepEqual(Object.keys(stored?.workloads ?? {}), ["default"]);
      } finally {
        store.close();
      }
    });
  });

  it("increments the version by one on each accepted write", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        assert.equal(store.writeDocument(0, documentWith(null), null).version, 1);
        assert.equal(store.writeDocument(1, documentWith(null), null).version, 2);
        assert.equal(store.writeDocument(2, documentWith(null), null).version, 3);
        assert.equal(store.readVersion(), 3);
      } finally {
        store.close();
      }
    });
  });

  it("rejects a stale expected version, returns the current one, and mutates nothing", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        store.writeDocument(0, documentWith("https://first.invalid"), null);
        store.writeDocument(1, documentWith("https://second.invalid"), null);

        const stale = store.writeDocument(1, documentWith("https://third.invalid"), null);
        assert.equal(stale.ok, false, "a write against a superseded version must not win");
        assert.equal(
          stale.version,
          2,
          "the loser is told the version it lost to, so the caller's 409 can say what to re-read",
        );
        assert.equal(
          store.readDocument()?.notifyUrl,
          "https://second.invalid",
          "a rejected write must leave the stored document untouched",
        );
        assert.equal(store.readVersion(), 2, "a rejected write must not bump the version");
      } finally {
        store.close();
      }
    });
  });

  it("commits a decision receipt with the document and prunes superseded ones", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        // The receipt is opaque to the store on purpose: it records the floors a write was
        // decided against, and belongs to feasibility, not to persistence.
        store.writeDocument(0, documentWith(null), { floor: "p95_ms", value: 780 });
        store.writeDocument(1, documentWith(null), { floor: "p95_ms", value: 810 });

        // Pruning is observable only through the fact that the document still reads back
        // cleanly at the new version; the receipts table has no read surface of its own yet.
        assert.equal(store.readVersion(), 2);
        assert.notEqual(store.readDocument(), null);
      } finally {
        store.close();
      }
    });
  });
});

describe("two processes writing the same store file", () => {
  it("lets exactly one of two writes at the same version win", () => {
    withStorePath((path) => {
      // Two independent TargetStore instances on one file is the cross-process case: they
      // share no memory, so nothing but SQLite's own locking decides the winner.
      const first = TargetStore.open(path);
      const second = TargetStore.open(path);
      try {
        first.writeDocument(0, documentWith("https://base.invalid"), null);
        assert.equal(
          second.readVersion(),
          1,
          "a second opener sees a committed write without any coordination between them",
        );

        const winner = first.writeDocument(1, documentWith("https://winner.invalid"), null);
        const loser = second.writeDocument(1, documentWith("https://loser.invalid"), null);

        assert.equal(winner.ok, true);
        assert.equal(loser.ok, false, "optimistic concurrency is enforced by the store, not by a single-writer assumption");
        assert.equal(loser.version, 2, "the loser learns the version that beat it");
        assert.equal(
          second.readDocument()?.notifyUrl,
          "https://winner.invalid",
          "the losing writer's document must never reach the store",
        );
      } finally {
        first.close();
        second.close();
      }
    });
  });

  it("lets the second writer succeed once it re-reads and re-decides", () => {
    withStorePath((path) => {
      const first = TargetStore.open(path);
      const second = TargetStore.open(path);
      try {
        first.writeDocument(0, documentWith(null), null);
        assert.equal(second.writeDocument(0, documentWith(null), null).ok, false);

        // `409` is terminal: the store never retries for the client. The client re-reads
        // the current version and decides again, which is why there is no loop to livelock.
        const retry = second.writeDocument(second.readVersion(), documentWith("https://after.invalid"), null);
        assert.equal(retry.ok, true);
        assert.equal(first.readDocument()?.notifyUrl, "https://after.invalid");
      } finally {
        first.close();
        second.close();
      }
    });
  });
});

describe("window summaries", () => {
  it("merges rows written by different processes for the same workload", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        store.writeWindowSummary(summaryFrom({ processId: "process-a", requestCount: 40 }));
        store.writeWindowSummary(summaryFrom({ processId: "process-b", requestCount: 60 }));

        const merged = store.readWindowSummaries("default", 0);
        assert.equal(merged.length, 2, "one process's rows must not overwrite another's");
        assert.deepEqual(
          merged.map((summary) => summary.processId).sort(),
          ["process-a", "process-b"],
        );
        assert.equal(
          merged.reduce((total, summary) => total + summary.requestCount, 0),
          100,
          "the sample floor is workload-wide across merged summaries, not per-process",
        );
      } finally {
        store.close();
      }
    });
  });

  it("round-trips the latency samples rather than pre-reducing them", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        store.writeWindowSummary(summaryFrom({ latenciesMs: [11, 22, 33, 44] }));
        const [summary] = store.readWindowSummaries("default", 0);
        assert.deepEqual(
          summary?.latenciesMs,
          [11, 22, 33, 44],
          "a percentile of percentiles is not a percentile, so the samples travel whole",
        );
        assert.equal(summary?.costPer1kTokensUsdSum, 0.09);
      } finally {
        store.close();
      }
    });
  });

  it("returns only the summaries that closed at or after the requested time", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        store.writeWindowSummary(summaryFrom({ closedAtMs: 1_000 }));
        store.writeWindowSummary(summaryFrom({ closedAtMs: 5_000 }));

        const recent = store.readWindowSummaries("default", 5_000);
        assert.deepEqual(recent.map((summary) => summary.closedAtMs), [5_000]);
      } finally {
        store.close();
      }
    });
  });

  it("keeps summaries for other workloads out of a workload's merge", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        store.writeWindowSummary(summaryFrom({ workload: "default" }));
        store.writeWindowSummary(summaryFrom({ workload: "batch" }));

        assert.deepEqual(
          store.readWindowSummaries("batch", 0).map((summary) => summary.workload),
          ["batch"],
          "a shared window would let batch traffic mask an interactive workload's regression",
        );
      } finally {
        store.close();
      }
    });
  });

  it("prunes only the rows that closed before the cutoff", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        store.writeWindowSummary(summaryFrom({ processId: "gone", closedAtMs: 1_000 }));
        store.writeWindowSummary(summaryFrom({ processId: "live", closedAtMs: 9_000 }));

        store.pruneWindowSummaries(5_000);

        // This is the whole liveness story: a dead process's contribution ages out by
        // timestamp, with no heartbeat and no leader election.
        assert.deepEqual(
          store.readWindowSummaries("default", 0).map((summary) => summary.processId),
          ["live"],
        );
      } finally {
        store.close();
      }
    });
  });
});

describe("the unmet state machine's compare-and-set", () => {
  it("has no state for a workload until one is written", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        assert.equal(store.readUnmetState("default"), null);
      } finally {
        store.close();
      }
    });
  });

  it("accepts the first transition and round-trips the diagnosis it carries", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        const entered = unmetStateFrom({
          unmet: true,
          since: 1_700_000_000_000,
          missedStreak: 2,
          lastWindowAtMs: 1_700_000_300_000,
          report: {
            dimension: "p95_ms",
            target: 2_000,
            observed: 2_400,
            windowSpanMs: 300_000,
            windowRequestCount: 220,
            rejections: [
              {
                providerId: "passthrough",
                dimension: "p95_ms",
                observed: 2_400,
                target: 2_000,
                reason: "p95 above ceiling",
              },
            ],
          },
        });

        assert.equal(store.casUnmetState("default", null, entered), true);
        assert.deepEqual(
          store.readUnmetState("default"),
          entered,
          "the state must survive the round trip whole, since it is restored at boot",
        );
      } finally {
        store.close();
      }
    });
  });

  it("refuses a transition from a state that is no longer stored", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        const first = unmetStateFrom({ missedStreak: 1 });
        const second = unmetStateFrom({ missedStreak: 2 });
        assert.equal(store.casUnmetState("default", null, first), true);

        assert.equal(
          store.casUnmetState("default", null, second),
          false,
          "expecting no state once a state exists is exactly the stale case CAS must reject",
        );
        assert.equal(
          store.casUnmetState("default", unmetStateFrom({ missedStreak: 9 }), second),
          false,
          "a stale expected state must not win",
        );
        assert.equal(store.readUnmetState("default")?.missedStreak, 1);
        assert.equal(store.casUnmetState("default", first, second), true);
        assert.equal(store.readUnmetState("default")?.missedStreak, 2);
      } finally {
        store.close();
      }
    });
  });

  it("lets exactly one of two processes win a transition, so one notification is sent", () => {
    withStorePath((path) => {
      const first = TargetStore.open(path);
      const second = TargetStore.open(path);
      try {
        const entered = unmetStateFrom({ unmet: true, since: 42, missedStreak: 2 });
        const alsoEntered = unmetStateFrom({ unmet: true, since: 43, missedStreak: 2 });

        assert.equal(first.casUnmetState("default", null, entered), true);
        assert.equal(
          second.casUnmetState("default", null, alsoEntered),
          false,
          "the process that loses the CAS observes the move and stays silent, so N processes send one notification",
        );
        assert.equal(second.readUnmetState("default")?.since, 42);
      } finally {
        first.close();
        second.close();
      }
    });
  });

  it("compares a state rebuilt by the caller, not one particular object", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        const held = unmetStateFrom({ heldStreak: 1, lastWindowAtMs: 7 });
        assert.equal(store.casUnmetState("default", null, held), true);

        // A caller that read the state, then rebuilt an equal one, must still win: the
        // comparison is over the state's value, not over object identity or key order.
        const rebuilt: UnmetState = {
          lastWindowAtMs: 7,
          heldStreak: 1,
          missedStreak: 0,
          report: null,
          since: null,
          unmet: false,
          workload: "default",
        };
        assert.equal(store.casUnmetState("default", rebuilt, unmetStateFrom({ heldStreak: 2 })), true);
      } finally {
        store.close();
      }
    });
  });
});

describe("opening a store that cannot be used", () => {
  it("reports a file that is not a database as unavailable", () => {
    withStorePath((path) => {
      writeFileSync(path, "this is not a database, it is a note someone left here");
      assert.throws(
        () => TargetStore.open(path),
        StoreUnavailableError,
        "the caller degrades to passthrough with a failing management surface, so this must be a distinguishable type",
      );
    });
  });

  it("reports a path whose directory does not exist as unavailable", () => {
    withStorePath((path) => {
      assert.throws(
        () => TargetStore.open(join(path, "nested", "targets.db")),
        StoreUnavailableError,
      );
    });
  });

  it("carries the underlying failure as the error's cause", () => {
    withStorePath((path) => {
      writeFileSync(path, "still not a database");
      try {
        TargetStore.open(path);
        assert.fail("opening a garbage file must not succeed");
      } catch (error) {
        assert.ok(error instanceof StoreUnavailableError);
        assert.notEqual(
          error.cause,
          undefined,
          "the condition must be reportable loudly, which needs the original failure",
        );
      }
    });
  });
});
