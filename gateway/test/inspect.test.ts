import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSnapshot, renderSnapshot } from "../src/dev/inspect.js";
import { TargetStore } from "../src/targets/store.js";
import type { Provider, ReservationDocument, TargetDocument, UnmetState } from "../src/types.js";

/**
 * The inspection command is a debugging affordance, and a debugging affordance that lies is
 * worse than none: an engineer who trusts it stops looking at the thing it misreports. So the
 * tests below assert the two facts it exists to state — what routing would choose, and whether
 * the connector is actually running that choice — rather than the shape of its output.
 */

let directories = 0;
function withStore(body: (store: TargetStore, path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), `gateway-inspect-${process.pid}-${directories++}-`));
  const path = join(directory, "targets.db");
  const store = TargetStore.open(path);
  try {
    body(store, path);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}

const PROVIDERS: readonly Provider[] = [
  { id: "fast", baseUrl: "http://localhost:9001", model: "m", host: "fast-host", region: "local", serviceTier: "standard" },
  { id: "slow", baseUrl: "http://localhost:9002", model: "m", host: "slow-host", region: "local", serviceTier: "standard" },
];

const DOCUMENT: TargetDocument = {
  version: 0,
  notifyUrl: null,
  workloads: {
    default: {
      name: "default",
      allowedModels: [{ model: "m", host: null }],
      dimensions: { p95_ms: 2_000 },
      declarationOrder: ["p95_ms"],
      objective: "p95_ms",
      priority: ["p95_ms"],
      hard: null,
    },
  },
};

function options(path: string, nowMs: number) {
  return {
    storePath: path,
    providers: PROVIDERS,
    providerSource: "GATEWAY_PROVIDERS" as const,
    nowMs,
    windowMs: 300_000,
    sampleFloor: 2,
  };
}

describe("inspect", () => {
  it("ranks providers the way the measured window says routing would", () => {
    withStore((store, path) => {
      const now = 10_000_000;
      store.writeDocument(0, DOCUMENT, null);
      for (const [providerId, latency] of [
        ["fast", 100],
        ["slow", 900],
      ] as const) {
        store.writeWindowSummary({
          workload: "default",
          providerId,
          processId: "p1",
          openedAtMs: now - 60_000,
          closedAtMs: now - 30_000,
          latenciesMs: [latency, latency, latency],
          successCount: 3,
          requestCount: 3,
          costPer1kTokensUsdSum: 0.03,
        });
      }

      const snapshot = buildSnapshot(store, options(path, now));
      const workload = snapshot.workloads[0];
      assert.equal(snapshot.targetVersion, 1);
      assert.equal(workload?.workload, "default");
      assert.equal(workload?.observations.length, 2);
      assert.deepEqual(
        workload?.rankedList?.providers.map((provider) => provider.providerId),
        ["fast", "slow"],
      );
    });
  });

  it("calls a directive stale exactly when the acked version is not the pushed one", () => {
    withStore((store, path) => {
      const now = 10_000_000;
      store.writeDocument(0, DOCUMENT, null);
      store.recordDirectiveDelivery("default", 4, "push", now - 1_000);
      let snapshot = buildSnapshot(store, options(path, now));
      assert.equal(snapshot.workloads[0]?.directive?.stale, true);
      assert.equal(snapshot.workloads[0]?.directive?.ackDelayMs, null);

      store.recordDirectiveAck("default", 4, now - 800);
      snapshot = buildSnapshot(store, options(path, now));
      assert.equal(snapshot.workloads[0]?.directive?.stale, false);
      assert.equal(snapshot.workloads[0]?.directive?.ackDelayMs, 200);
      assert.match(renderSnapshot(snapshot), /pushed v4 by push, acked 4 after 200ms/);
    });
  });

  it("reports unmet state, reported usage, and reservation liveness", () => {
    withStore((store, path) => {
      const now = 10_000_000;
      store.writeDocument(0, DOCUMENT, null);

      const unmet: UnmetState = {
        workload: "default",
        unmet: true,
        since: now - 5_000,
        missedStreak: 2,
        heldStreak: 0,
        lastWindowAtMs: now - 1_000,
        report: {
          dimension: "p95_ms",
          target: 2_000,
          observed: 4_000,
          windowSpanMs: 300_000,
          windowRequestCount: 200,
          rejections: [],
        },
      };
      assert.equal(store.casUnmetState("default", null, unmet), true);

      store.writeConnectorUsage([
        {
          workload: "default",
          providerId: "fast",
          model: "m",
          region: "local",
          promptTokens: 10,
          completionTokens: 20,
          latencyMs: 120,
          statusCode: 200,
          rateLimitLimit: null,
          rateLimitReset: null,
          reservationId: null,
          atMs: now - 2_000,
        },
      ]);

      const reservations: ReservationDocument = {
        version: 0,
        reservations: [
          {
            id: "expired",
            host: "fast-host",
            model: "m",
            region: "local",
            sizeUnits: 1,
            unit: "ptu",
            termStartMs: now - 20_000,
            termEndMs: now - 10_000,
            effectiveRatePer1kTokensUsd: 0.001,
            addressingModel: "m-reserved",
          },
        ],
      };
      store.writeReservations(0, reservations);

      const snapshot = buildSnapshot(store, options(path, now));
      const workload = snapshot.workloads[0];
      assert.equal(workload?.unmet, true);
      assert.equal(workload?.unmetDimension, "p95_ms");
      assert.equal(workload?.reportedRequestCount, 1);
      assert.equal(workload?.reportedCompletionTokens, 20);
      assert.equal(snapshot.reservations[0]?.live, false);
      // An expired reservation must not reach the ranked list, or the connector would call a
      // provisioned endpoint the customer stopped paying for.
      assert.equal(workload?.rankedList?.providers.every((p) => p.reservationId === null), true);
    });
  });

  it("redacts connector tokens", () => {
    withStore((store, path) => {
      const minted = store.mintConnector(1_000);
      const snapshot = buildSnapshot(store, options(path, 10_000_000));
      const rendered = renderSnapshot(snapshot);
      assert.equal(snapshot.connectors.length, 1);
      assert.equal(rendered.includes(minted.token), false);
      assert.equal(rendered.includes(minted.token.slice(0, 8)), true);
    });
  });

  it("says so plainly when no target document has been written", () => {
    withStore((store, path) => {
      const snapshot = buildSnapshot(store, options(path, 10_000_000));
      assert.equal(snapshot.targetVersion, 0);
      assert.equal(snapshot.workloads.length, 0);
      assert.match(renderSnapshot(snapshot), /No workload has been declared/);
    });
  });
});
