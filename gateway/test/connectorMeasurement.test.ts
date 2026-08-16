import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../src/config.js";
import { usageOutcome } from "../src/controlplane/usageOutcome.js";
import { handleManagementRequest } from "../src/management/api.js";
import { CATALOGUE_EPOCH_MS } from "../src/providers/capabilities.js";
import { classifyStatus } from "../src/routing/stats.js";
import { createGateway } from "../src/server.js";
import { TargetService } from "../src/targets/service.js";
import type { StatusResource } from "../src/targets/service.js";
import type { ConnectorUsageRecord } from "../src/targets/store.js";
import { INSUFFICIENT_DATA } from "../src/types.js";
import type { Provider, Reservation } from "../src/types.js";

/**
 * Measurement fed by the connector, with the gateway out of the request path.
 *
 * This is the file that guards the gap the milestone's end-to-end run exposed. Every other
 * test of `unmet`, of the ranked list's ordering, and of the status resource's dimensions
 * reaches the rolling windows through `server.ts` — the in-path data path. That path is
 * exactly what this architecture removes: once a connector is installed the gateway
 * forwards nothing, so if usage reports do not reach the windows then every one of those
 * behaviors is inert in the only configuration the product ships in, while continuing to
 * pass its own tests.
 *
 * So the discipline here is deliberate and absolute: **nothing below ever issues a
 * chat-completion request to the gateway.** The only input is a connector's usage report
 * over HTTP.
 */

const SLOW: Provider = {
  id: "sim-a",
  baseUrl: "http://sim-a.invalid",
  model: "sim-fast",
  host: "sim-a",
  region: "local",
  serviceTier: "standard",
};

const WINDOW_MS = 1_000;

/** Comfortably above the 300ms ceiling the workload below states. */
const BREACHING_LATENCY_MS = 900;

interface Harness {
  readonly baseUrl: string;
  readonly service: TargetService;
  readonly token: string;
  /** Advances the clock the service and the windows read. */
  advanceTo(ms: number): void;
  now(): number;
  report(records: readonly Partial<ConnectorUsageRecord>[]): Promise<void>;
  status(workload: string): StatusResource;
}

function usageRecord(overrides: Partial<ConnectorUsageRecord>, atMs: number): ConnectorUsageRecord {
  return {
    workload: "default",
    providerId: SLOW.id,
    model: SLOW.model,
    region: SLOW.region,
    promptTokens: 10,
    completionTokens: 20,
    latencyMs: BREACHING_LATENCY_MS,
    statusCode: 200,
    rateLimitLimit: null,
    rateLimitReset: null,
    reservationId: null,
    atMs,
    ...overrides,
  };
}

async function withGateway(run: (harness: Harness) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "gateway-measure-"));
  const storePath = join(dir, "store.sqlite");
  let clock = CATALOGUE_EPOCH_MS;

  const resolved: Config = {
    upstreamBaseUrl: "http://upstream.invalid",
    port: 0,
    forceRouterError: false,
    storePath,
    notifySecret: null,
    // The test drives `tick` itself; a timer racing it would make the assertions flaky.
    pollMs: 1_000_000,
    windowMs: WINDOW_MS,
    windowMinRequests: 2,
    sampleFloor: 2,
    notifyRetryMs: 1_000,
    providers: [SLOW],
    adminToken: "admin-secret",
    pushDebounceMs: 25,
    sseDisabled: false,
  };

  const service = TargetService.start(
    {
      storePath,
      pollMs: resolved.pollMs,
      windowMs: resolved.windowMs,
      windowMinRequests: resolved.windowMinRequests,
      sampleFloor: resolved.sampleFloor,
      providers: resolved.providers,
    },
    { nowMs: () => clock },
  );

  const server = createGateway(resolved, { service });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const token = service.storeFor("default")?.mintConnector(clock).token ?? "";

  const put = (version: number, workloads: unknown): void => {
    const response = handleManagementRequest(
      { method: "PUT", path: "/v1/targets", body: JSON.stringify({ version, workloads }) },
      service,
      clock,
    );
    assert.equal(response.status, 200, `target write rejected: ${response.body}`);
  };

  put(0, {
    default: {
      allowed_models: ["sim-fast@sim-a"],
      p95_ms: 300,
    },
  });

  const harness: Harness = {
    baseUrl,
    service,
    token,
    advanceTo(ms) {
      clock = ms;
    },
    now: () => clock,
    async report(records) {
      const body = JSON.stringify({
        records: records.map((record) => usageRecord(record, clock)),
        strainDropped: 0,
        usageDropped: 0,
      });
      const response = await fetch(`${baseUrl}/v1/connector/usage`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body,
      });
      assert.equal(response.status, 204, "a usage report must always be acknowledged");
    },
    status(workload) {
      const response = handleManagementRequest(
        { method: "GET", path: `/v1/workloads/${workload}/status`, body: "" },
        service,
        clock,
      );
      assert.equal(response.status, 200, response.body);
      return JSON.parse(response.body) as StatusResource;
    },
  };

  try {
    await run(harness);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    service.stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

/** One window's worth of reports, then the tick that closes it. */
async function reportWindow(harness: Harness, count: number, atMs: number): Promise<void> {
  harness.advanceTo(atMs);
  await harness.report(Array.from({ length: count }, () => ({})));
  // Past the span, so `closeDue` finds the window complete.
  harness.advanceTo(atMs + WINDOW_MS + 1);
  harness.service.tick(harness.now());
}

describe("a connector's usage reports are measurement, not only billing", () => {
  it("moves a provider off insufficient_data without one in-path request", async () => {
    await withGateway(async (harness) => {
      const before = harness.status("default");
      assert.equal(
        before.dimensions[0]?.observed,
        INSUFFICIENT_DATA,
        "nothing has been reported yet, so there is nothing to observe",
      );

      await reportWindow(harness, 4, CATALOGUE_EPOCH_MS);

      const after = harness.status("default");
      const observed = after.dimensions[0]?.observed;
      assert.notEqual(
        observed,
        INSUFFICIENT_DATA,
        "reports reached the store but never the windows: the measurement gap is back",
      );
      assert.equal(
        observed,
        BREACHING_LATENCY_MS,
        "the p95 the gateway reports must be the latency the connector measured",
      );
    });
  });

  it("reaches unmet on reports alone, which is the only way it can happen in production", async () => {
    await withGateway(async (harness) => {
      // Two consecutive missed windows: the state machine's entry rule is deliberately
      // symmetric, so one breaching window must not be enough.
      await reportWindow(harness, 4, CATALOGUE_EPOCH_MS);
      assert.equal(
        harness.status("default").unmet,
        false,
        "one missed window must not raise unmet; the two-window rule is the anti-flap",
      );

      await reportWindow(harness, 4, CATALOGUE_EPOCH_MS + WINDOW_MS * 3);

      const status = harness.status("default");
      assert.equal(status.unmet, true, "two missed windows of reported traffic must raise unmet");
      assert.equal(
        harness.service.unmetDimension("default"),
        "p95_ms",
        "the connector needs the bound dimension to write the response header",
      );
    });
  });
});

describe("what a reported call means to measurement", () => {
  const context = { providers: [SLOW], liveReservations: [] as readonly Reservation[] };

  it("counts a 429 and a 5xx against success_rate, because absorbing them is the product", () => {
    for (const statusCode of [429, 500, 503]) {
      const result = usageOutcome(usageRecord({ statusCode }, 1), context);
      assert.ok("outcome" in result, `${statusCode} must be measured, not dropped`);
      assert.equal(result.outcome.success, false);
      assert.equal(result.outcome.malformed, false);
    }
  });

  it("excludes a malformed customer request from the denominator entirely", () => {
    const result = usageOutcome(usageRecord({ statusCode: 400 }, 1), context);
    assert.ok("dropped" in result, "a 400 is the customer's own bug, not provider risk");
    assert.equal(result.dropped, "malformed");
  });

  it("treats the connector's transport-failure encoding as provider risk, not success", () => {
    // The trap: `0 < 400`, so a status-code check written the obvious way scores a call
    // that never reached a provider as a success.
    assert.deepEqual(classifyStatus(0), { success: false, malformed: false });
    const result = usageOutcome(usageRecord({ statusCode: 0 }, 1), context);
    assert.ok("outcome" in result);
    assert.equal(result.outcome.success, false);
  });

  it("prices an addressed reservation at the customer's rate, not the public one", () => {
    const reservation: Reservation = {
      id: "acme-1",
      host: SLOW.host,
      model: SLOW.model,
      region: SLOW.region,
      sizeUnits: 1,
      unit: "model_units",
      termStartMs: 0,
      termEndMs: Number.MAX_SAFE_INTEGER,
      effectiveRatePer1kTokensUsd: 0.00001,
      addressingModel: "arn:aws:bedrock:local:1:provisioned-model/acme",
    };

    const onDemand = usageOutcome(usageRecord({}, 1), context);
    const reserved = usageOutcome(usageRecord({ reservationId: "acme-1" }, 1), {
      providers: [SLOW],
      liveReservations: [reservation],
    });

    assert.ok("outcome" in onDemand && "outcome" in reserved);
    assert.equal(reserved.outcome.costPer1kTokensUsd, 0.00001);
    assert.ok(
      reserved.outcome.costPer1kTokensUsd < onDemand.outcome.costPer1kTokensUsd,
      "a reservation the call addressed must not be measured at the public rate",
    );
  });

  it("refuses to invent a rate for a provider it has no catalogue entry for", () => {
    const result = usageOutcome(usageRecord({ providerId: "who", model: "who" }, 1), context);
    assert.ok("dropped" in result, "a zero rate would look like free capacity");
    assert.equal(result.dropped, "unpriceable");
  });
});
