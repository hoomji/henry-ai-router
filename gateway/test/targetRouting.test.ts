import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleManagementRequest } from "../src/management/api.js";
import { UnmetNotifier } from "../src/management/notify.js";
import { CATALOGUE_EPOCH_MS } from "../src/providers/capabilities.js";
import { chooseProvider } from "../src/routing/chooseProvider.js";
import { TargetService } from "../src/targets/service.js";
import { INSUFFICIENT_DATA } from "../src/types.js";
import type { Provider, UnmetState } from "../src/types.js";

/**
 * M2's acceptance evidence, as executable checks.
 *
 * Each `describe` below corresponds to one of the ExecPlan's named verification steps, so
 * a reader can line the two up without interpretation. They run against the real store and
 * the real state machine — only the clock is injected, because a two-window `unmet`
 * transition measured against wall time would be a five-minute test that nobody runs.
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

const WINDOW_MS = 1_000;

/**
 * The demo window is a thousand times shorter than the production one (5 minutes / 200
 * requests). The shape is what is under test — two consecutive windows in, two out — and
 * that shape is independent of how long a window happens to be.
 */
function serviceConfig(storePath: string) {
  return {
    storePath,
    pollMs: 1_000_000,
    windowMs: WINDOW_MS,
    windowMinRequests: 2,
    sampleFloor: 2,
    providers: [FAST, SLOW_CHEAP],
  };
}

function withStore(run: (storePath: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "gateway-m2-"));
  const storePath = join(dir, "store.sqlite");
  return (async () => {
    try {
      await run(storePath);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  })();
}

function targetsBody(version: number, workloads: unknown): string {
  return JSON.stringify({ version, workloads });
}

const DEFAULT_WORKLOADS = {
  default: {
    allowed_models: ["sim-fast@sim-a", "sim-cheap@sim-b"],
    p95_ms: 300,
    objective: "cost_per_1k_tokens_usd",
  },
};

function put(service: TargetService, version: number, workloads: unknown, nowMs: number) {
  return handleManagementRequest(
    { method: "PUT", path: "/v1/targets", body: targetsBody(version, workloads) },
    service,
    nowMs,
  );
}

function status(service: TargetService, workload: string, nowMs: number) {
  return handleManagementRequest(
    { method: "GET", path: `/v1/workloads/${workload}/status`, body: "" },
    service,
    nowMs,
  );
}

/** Drive one full window in which every request to both providers was slow. */
function runWindow(
  service: TargetService,
  clock: { now: number },
  latencyMs: number,
  workload = "default",
): void {
  for (const provider of [FAST, SLOW_CHEAP]) {
    for (let i = 0; i < 2; i += 1) {
      service.record({
        workload,
        providerId: provider.id,
        latencyMs,
        costPer1kTokensUsd: provider.id === "sim-a" ? 0.03 : 0.002,
        success: true,
        malformed: false,
        atMs: clock.now,
      });
    }
  }
  clock.now += WINDOW_MS + 1;
  service.tick(clock.now);
}

describe("a target no allowed provider can satisfy is rejected when it is written", () => {
  it("returns 422 naming the best achievable value and the provider achieving it", async () => {
    await withStore((storePath) => {
      const nowMs = CATALOGUE_EPOCH_MS;
      const service = TargetService.start(serviceConfig(storePath), { nowMs: () => nowMs });

      try {
        const response = put(
          service,
          0,
          {
            default: {
              allowed_models: ["sim-fast@sim-a", "sim-cheap@sim-b"],
              p95_ms: 1,
              objective: "none",
            },
          },
          nowMs,
        );

        assert.equal(response.status, 422, "an arithmetically impossible target is rejected at write time");
        const body = JSON.parse(response.body) as {
          error: string;
          reports: {
            dimension: string;
            requested: number;
            bestAchievable: number;
            providerId: string;
            floorProvenance: string;
            floorAgeMs: number;
          }[];
        };

        assert.equal(body.error, "infeasible_by_declaration");
        const report = body.reports[0];
        assert.ok(report !== undefined, "a rejection must carry its report");
        assert.equal(report.dimension, "p95_ms");
        assert.equal(report.requested, 1);
        assert.equal(
          report.bestAchievable,
          120,
          "the report must name what the fastest allowed model actually floors at",
        );
        assert.equal(report.providerId, "sim-a", "and which provider achieves it");
        assert.ok(
          typeof report.floorProvenance === "string" && report.floorAgeMs >= 0,
          "a rejection must disclose its own basis: the floor's source and its age",
        );
      } finally {
        service.stop();
      }
    });
  });

  it("accepts a target inside the floor's own variance, because rejection is biased against itself", async () => {
    await withStore((storePath) => {
      const nowMs = CATALOGUE_EPOCH_MS;
      const service = TargetService.start(serviceConfig(storePath), { nowMs: () => nowMs });

      try {
        // The sim-fast p95 floor is 120 with a variance of 25. A target of 100 is below
        // the floor but inside its variance, and the spec rejects only what fails the most
        // optimistic candidate floor by MORE than that floor's own variance.
        const response = put(
          service,
          0,
          {
            default: {
              allowed_models: ["sim-fast@sim-a"],
              p95_ms: 100,
              objective: "none",
            },
          },
          nowMs,
        );

        assert.equal(response.status, 200, "a target inside the floor's variance must be accepted");
      } finally {
        service.stop();
      }
    });
  });
});

describe("a concurrent write with a stale version is rejected", () => {
  it("returns 409 with the current version and does not apply the second write", async () => {
    await withStore((storePath) => {
      const nowMs = CATALOGUE_EPOCH_MS;
      const service = TargetService.start(serviceConfig(storePath), { nowMs: () => nowMs });

      try {
        assert.equal(put(service, 0, DEFAULT_WORKLOADS, nowMs).status, 200);

        const second = put(
          service,
          0,
          {
            default: {
              allowed_models: ["sim-cheap@sim-b"],
              p95_ms: 900,
              objective: "none",
            },
          },
          nowMs,
        );

        assert.equal(second.status, 409, "a write against a version that has moved must not land");
        const body = JSON.parse(second.body) as { currentVersion: number };
        assert.equal(body.currentVersion, 1);

        const document = service.document();
        assert.deepEqual(
          document?.workloads["default"]?.allowedModels.map((entry) => entry.model),
          ["sim-fast", "sim-cheap"],
          "the losing write must leave the document exactly as the winner left it",
        );
      } finally {
        service.stop();
      }
    });
  });
});

describe("a target that stops holding raises unmet after two windows and clears after two", () => {
  it("enters on the second missed window, not the first, and leaves on the second held window", async () => {
    await withStore((storePath) => {
      const clock = { now: CATALOGUE_EPOCH_MS };
      const transitions: { transition: string; state: UnmetState }[] = [];
      const service = TargetService.start(serviceConfig(storePath), {
        nowMs: () => clock.now,
        onTransition: (transition, state) => transitions.push({ transition, state }),
      });

      try {
        assert.equal(put(service, 0, DEFAULT_WORKLOADS, clock.now).status, 200);

        // Both providers degrade well past the 300ms ceiling.
        runWindow(service, clock, 900);
        assert.equal(
          service.unmetDimension("default"),
          null,
          "one missed window is not enough: the entry threshold is two consecutive windows",
        );

        runWindow(service, clock, 900);
        assert.equal(
          service.unmetDimension("default"),
          "p95_ms",
          "the second consecutive missed window raises unmet, naming the bound dimension",
        );
        assert.equal(transitions.length, 1, "exactly one entry transition fires");
        assert.equal(transitions[0]?.transition, "entered");

        const raised = JSON.parse(status(service, "default", clock.now).body) as {
          unmet: boolean;
          report: { dimension: string; target: number; observed: number };
        };
        assert.equal(raised.unmet, true, "the status resource is the authoritative record");
        assert.equal(raised.report.dimension, "p95_ms");
        assert.equal(raised.report.target, 300);
        assert.ok(
          raised.report.observed >= 900,
          "the report must carry the observed value, not just the target it missed",
        );

        // The providers recover.
        runWindow(service, clock, 50);
        assert.equal(
          service.unmetDimension("default"),
          "p95_ms",
          "one held window must NOT clear unmet — the symmetry with entry is deliberate anti-flap",
        );

        runWindow(service, clock, 50);
        assert.equal(
          service.unmetDimension("default"),
          null,
          "the second consecutive held window clears it",
        );
        assert.equal(transitions.length, 2, "an exit transition fires exactly once");
        assert.equal(transitions[1]?.transition, "left");
      } finally {
        service.stop();
      }
    });
  });
});

describe("unmet survives a restart while the measurement window does not", () => {
  it("still reports unmet with its binding reason, fires no duplicate notification, and reports insufficient_data until the window refills", async () => {
    await withStore((storePath) => {
      const clock = { now: CATALOGUE_EPOCH_MS };
      const transitions: string[] = [];
      const first = TargetService.start(serviceConfig(storePath), {
        nowMs: () => clock.now,
        onTransition: (transition) => transitions.push(transition),
      });

      try {
        assert.equal(put(first, 0, DEFAULT_WORKLOADS, clock.now).status, 200);
        runWindow(first, clock, 900);
        runWindow(first, clock, 900);
        assert.equal(first.unmetDimension("default"), "p95_ms");
        assert.equal(transitions.length, 1);
      } finally {
        first.stop();
      }

      // The process restarts against the same store.
      const second = TargetService.start(serviceConfig(storePath), {
        nowMs: () => clock.now,
        onTransition: (transition) => transitions.push(transition),
      });

      try {
        const restored = JSON.parse(status(second, "default", clock.now).body) as {
          unmet: boolean;
          report: { dimension: string } | null;
          dimensions: { dimension: string; observed: unknown }[];
        };

        assert.equal(restored.unmet, true, "a workload's unmet state survives a gateway restart");
        assert.equal(
          restored.report?.dimension,
          "p95_ms",
          "and it survives with its binding reason, not merely as a flag",
        );
        assert.equal(
          restored.dimensions[0]?.observed,
          INSUFFICIENT_DATA,
          "its measurement window does not survive: a workload can be unmet and insufficient_data at once",
        );

        second.tick(clock.now);
        assert.equal(
          transitions.length,
          1,
          "restoring a persisted unmet state must not re-fire the entry notification",
        );
      } finally {
        second.stop();
      }
    });
  });
});

describe("unmet holds even when the notification cannot be delivered", () => {
  it("keeps the status resource reporting unmet after delivery is dropped", async () => {
    await withStore(async (storePath) => {
      const clock = { now: CATALOGUE_EPOCH_MS };
      const service = TargetService.start(serviceConfig(storePath), { nowMs: () => clock.now });

      try {
        assert.equal(put(service, 0, DEFAULT_WORKLOADS, clock.now).status, 200);
        runWindow(service, clock, 900);
        runWindow(service, clock, 900);

        // Nothing is listening on this port; delivery can only fail.
        const notifier = new UnmetNotifier({ retryMs: 50, initialBackoffMs: 10 });
        const outcome = await notifier.deliver("http://127.0.0.1:1/hook", "secret", {
          event: "unmet_entered",
          workload: "default",
          state: {
            workload: "default",
            unmet: true,
            since: clock.now,
            report: null,
            missedStreak: 2,
            heldStreak: 0,
            lastWindowAtMs: clock.now,
          },
          atMs: clock.now,
        });

        assert.equal(outcome.delivered, false, "an unreachable endpoint cannot be delivered to");
        assert.ok(outcome.droppedReason !== null, "and the drop is reported rather than silent");

        const body = JSON.parse(status(service, "default", clock.now).body) as { unmet: boolean };
        assert.equal(
          body.unmet,
          true,
          "this is the guarantee that makes dropping a notification acceptable: the status resource is the record, the notification never is",
        );
      } finally {
        service.stop();
      }
    });
  });
});

describe("a second workload with a different target routes differently in the same run", () => {
  it("sends default to the provider holding its latency ceiling and thrifty to the cheapest", async () => {
    await withStore((storePath) => {
      const clock = { now: CATALOGUE_EPOCH_MS };
      const service = TargetService.start(serviceConfig(storePath), { nowMs: () => clock.now });

      try {
        const response = put(
          service,
          0,
          {
            ...DEFAULT_WORKLOADS,
            thrifty: {
              allowed_models: ["sim-fast@sim-a", "sim-cheap@sim-b"],
              objective: "cost_per_1k_tokens_usd",
            },
          },
          clock.now,
        );
        assert.equal(response.status, 200);

        // The same traffic pattern under both workloads: fast-and-expensive versus
        // slow-and-cheap, which is exactly the trade the two targets disagree about.
        for (const workload of ["default", "thrifty"]) {
          for (const provider of [FAST, SLOW_CHEAP]) {
            for (let i = 0; i < 2; i += 1) {
              service.record({
                workload,
                providerId: provider.id,
                latencyMs: provider.id === "sim-a" ? 120 : 800,
                costPer1kTokensUsd: provider.id === "sim-a" ? 0.03 : 0.002,
                success: true,
                malformed: false,
                atMs: clock.now,
              });
            }
          }
        }
        clock.now += WINDOW_MS + 1;
        service.tick(clock.now);

        const request = { method: "POST", path: "/v1/chat/completions", headers: {}, body: "" };
        const forDefault = chooseProvider(request, service.providerState("default"));
        const forThrifty = chooseProvider(request, service.providerState("thrifty"));

        assert.equal(
          forDefault.provider?.id,
          "sim-a",
          "default states a 300ms ceiling, which only the fast provider holds",
        );
        assert.equal(
          forThrifty.provider?.id,
          "sim-b",
          "thrifty states no ceiling and minimizes cost, so the same snapshot routes elsewhere",
        );
        assert.notEqual(
          forDefault.provider?.id,
          forThrifty.provider?.id,
          "the workload named by x-gateway-workload is what decides, with no routing rule configured",
        );
      } finally {
        service.stop();
      }
    });
  });
});
