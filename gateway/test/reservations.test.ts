import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { computeRankedList } from "../src/controlplane/rankedList.js";
import {
  createSimProvider,
  SIM_ADDRESSED_HEADER,
  SIM_PROVIDER_HEADER,
} from "../src/dev/simProvider.js";
import { handleManagementRequest } from "../src/management/api.js";
import {
  parseReservationDocument,
  ReservationDocumentError,
  serializeReservationDocument,
} from "../src/reservations/document.js";
import { unaddressedCapacity } from "../src/reservations/unaddressed.js";
import { chooseProvider } from "../src/routing/chooseProvider.js";
import { DEFAULT_CUSTOMER_ID } from "../src/targets/store.js";
import type { ConnectorUsageRecord } from "../src/targets/store.js";
import { TargetService } from "../src/targets/service.js";
import type {
  GatewayRequest,
  Provider,
  ProviderObservation,
  ProviderState,
  Reservation,
  Workload,
} from "../src/types.js";

/**
 * M2's acceptance evidence for behavior 4, as executable checks.
 *
 * Each `describe` corresponds to one of the ExecPlan's named verification bullets. The
 * routing cases are pure — a snapshot in, a decision out — because that is the property the
 * seam is required to keep: term liveness is resolved *into* the snapshot by whoever built
 * it, so nothing here fakes a clock to make a reservation expire, it simply hands over a
 * different list.
 */

const FAST: Provider = {
  id: "sim-a",
  baseUrl: "http://sim-a.invalid",
  model: "sim-fast",
  host: "sim-a",
  region: "local",
  serviceTier: "standard",
};

const CHEAP: Provider = {
  id: "sim-b",
  baseUrl: "http://sim-b.invalid",
  model: "sim-cheap",
  host: "sim-b",
  region: "local",
  serviceTier: "standard",
};

const ARN = "arn:aws:bedrock:local:1:provisioned-model/fast";

const NOW = Date.UTC(2026, 7, 15);

function reservation(overrides: Partial<Reservation> = {}): Reservation {
  return {
    id: "acme-fast-1",
    host: "sim-a",
    model: "sim-fast",
    region: "local",
    sizeUnits: 2,
    unit: "model_units",
    termStartMs: NOW - 86_400_000,
    termEndMs: NOW + 86_400_000,
    effectiveRatePer1kTokensUsd: 0.0009,
    addressingModel: ARN,
    ...overrides,
  };
}

function wire(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "acme-fast-1",
    host: "sim-a",
    model: "sim-fast",
    region: "local",
    sizeUnits: 2,
    unit: "model_units",
    termStartMs: NOW - 86_400_000,
    termEndMs: NOW + 86_400_000,
    effectiveRatePer1kTokensUsd: 0.0009,
    addressingModel: ARN,
    ...overrides,
  };
}

const request: GatewayRequest = {
  method: "POST",
  path: "/v1/chat/completions",
  headers: {},
  body: "",
};

function observation(providerId: string, costPer1kTokensUsd: number, p95Ms: number): ProviderObservation {
  return {
    providerId,
    p95Ms,
    costPer1kTokensUsd,
    successRate: 0.999,
    windowSpanMs: 60_000,
    sampleCount: 50,
  };
}

function workloadWith(overrides: Partial<Workload> = {}): Workload {
  return {
    name: "default",
    allowedModels: [
      { model: "sim-fast", host: "sim-a" },
      { model: "sim-cheap", host: "sim-b" },
    ],
    dimensions: {},
    declarationOrder: [],
    objective: "cost_per_1k_tokens_usd",
    priority: [],
    hard: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

describe("the reservation document states only what the contract allows", () => {
  it("rejects an unknown key rather than dropping it", () => {
    assert.throws(
      () => parseReservationDocument({ reservations: [wire({ sizeUnts: 2 })] }, 1),
      (error: unknown) =>
        error instanceof ReservationDocumentError &&
        error.message.includes("unknown key in reservation"),
    );
  });

  it("rejects a term that ends before it starts", () => {
    assert.throws(
      () =>
        parseReservationDocument(
          { reservations: [wire({ termStartMs: NOW + 1_000, termEndMs: NOW })] },
          1,
        ),
      (error: unknown) =>
        error instanceof ReservationDocumentError &&
        error.message.includes("termEndMs must be after termStartMs"),
    );
  });

  it("rejects the same identifier twice, because the connector reports it back", () => {
    assert.throws(
      () => parseReservationDocument({ reservations: [wire(), wire()] }, 1),
      (error: unknown) => error instanceof ReservationDocumentError,
    );
  });

  it("round-trips through its wire form unchanged", () => {
    const parsed = parseReservationDocument({ reservations: [wire()] }, 3);
    const again = parseReservationDocument(serializeReservationDocument(parsed), 3);
    assert.deepEqual(again, parsed);
  });
});

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

describe("eligible traffic prefers the reservation-addressing path", () => {
  it("routes onto reserved capacity ahead of cheaper on-demand capacity", () => {
    const state: ProviderState = {
      providers: [FAST, CHEAP],
      observations: {
        // The on-demand provider is *cheaper* on the objective. The preference still holds:
        // the reserved capacity is already paid for, so not using it is not a saving.
        "sim-a": observation("sim-a", 0.004, 200),
        "sim-b": observation("sim-b", 0.0005, 200),
      },
      workload: workloadWith(),
      liveReservations: [reservation()],
    };

    assert.equal(chooseProvider(request, state).provider?.id, "sim-a");
  });

  it("is inert when the customer has declared no reservations", () => {
    const base: ProviderState = {
      providers: [FAST, CHEAP],
      observations: {
        "sim-a": observation("sim-a", 0.004, 200),
        "sim-b": observation("sim-b", 0.0005, 200),
      },
      workload: workloadWith(),
    };

    // The same snapshot minus the reservations must reach exactly the decision it reached
    // before this milestone existed, which is what makes the revert story clean.
    assert.equal(chooseProvider(request, base).provider?.id, "sim-b");
    assert.equal(
      chooseProvider(request, { ...base, liveReservations: [] }).provider?.id,
      "sim-b",
    );
  });

  it("stops preferring reserved capacity once the term is no longer live", () => {
    const expired = reservation({ termStartMs: NOW - 20_000, termEndMs: NOW - 10_000 });
    const state: ProviderState = {
      providers: [FAST, CHEAP],
      observations: {
        "sim-a": observation("sim-a", 0.004, 200),
        "sim-b": observation("sim-b", 0.0005, 200),
      },
      workload: workloadWith(),
      // Liveness is the snapshot builder's answer, not the seam's: an expired term is simply
      // absent here, and that is the whole mechanism by which a term expiring changes routing
      // without `chooseProvider` reading a clock.
      liveReservations: [],
    };

    assert.equal(chooseProvider(request, state).provider?.id, "sim-b");
    assert.ok(expired.termEndMs < NOW, "the fixture is the expired case it claims to be");
  });
});

describe("the reservation's effective rate reaches the routing decision", () => {
  it("holds a hard cost target the public rate cannot, and fails without the reservation", () => {
    const workload = workloadWith({
      dimensions: { cost_per_1k_tokens_usd: 0.001 },
      declarationOrder: ["cost_per_1k_tokens_usd"],
      priority: ["cost_per_1k_tokens_usd"],
      hard: "cost_per_1k_tokens_usd",
      objective: "none",
    });
    const observations = {
      "sim-a": observation("sim-a", 0.004, 200),
      "sim-b": observation("sim-b", 0.006, 200),
    };

    // On the catalogue's public rate nothing can hold it, and a hard dimension fails rather
    // than being breached.
    const onDemand = chooseProvider(request, {
      providers: [FAST, CHEAP],
      observations,
      workload,
    });
    assert.equal(onDemand.provider, null);
    assert.equal(onDemand.failedHard, "cost_per_1k_tokens_usd");

    // With the reservation declared, the same target is held — by the customer-specific rate,
    // which is a value the globally-keyed capability catalogue cannot express.
    const reserved = chooseProvider(request, {
      providers: [FAST, CHEAP],
      observations,
      workload,
      liveReservations: [reservation()],
    });
    assert.equal(reserved.provider?.id, "sim-a");
    assert.equal(reserved.failedHard, null);
  });
});

describe("a reservation is a preference, never an override", () => {
  it("does not attract traffic to a model outside allowed_models", () => {
    const state: ProviderState = {
      providers: [FAST, CHEAP],
      observations: {
        "sim-a": observation("sim-a", 0.004, 200),
        "sim-b": observation("sim-b", 0.0005, 200),
      },
      // The customer's blast radius names only the fast model. A reservation on the other one
      // is not permission to leave the list.
      workload: workloadWith({ allowedModels: [{ model: "sim-fast", host: "sim-a" }] }),
      liveReservations: [
        reservation({ id: "acme-cheap-1", model: "sim-cheap", host: "sim-b" }),
      ],
    };

    const decision = chooseProvider(request, state);
    assert.equal(decision.provider?.id, "sim-a");
    assert.ok(
      decision.rejected.some(
        (rejection) => rejection.providerId === "sim-b" && rejection.dimension === null,
      ),
      "the excluded provider is still named in the report, reservation or not",
    );
  });

  it("never wins over a hard dimension it breaches", () => {
    const workload = workloadWith({
      dimensions: { p95_ms: 300 },
      declarationOrder: ["p95_ms"],
      priority: ["p95_ms"],
      hard: "p95_ms",
    });
    const observations = {
      // The reserved provider is the slow one. A reservation is a price, not a promise about
      // latency, so it buys no relief from a ceiling the customer forbade us to concede.
      "sim-a": observation("sim-a", 0.004, 900),
      "sim-b": observation("sim-b", 0.0005, 100),
    };

    const decision = chooseProvider(request, {
      providers: [FAST, CHEAP],
      observations,
      workload,
      liveReservations: [reservation()],
    });
    assert.equal(decision.provider?.id, "sim-b");

    // And with nothing else allowed, the request fails rather than being served in breach.
    const alone = chooseProvider(request, {
      providers: [FAST],
      observations,
      workload,
      liveReservations: [reservation()],
    });
    assert.equal(alone.provider, null);
    assert.equal(alone.failedHard, "p95_ms");
  });
});

describe("the ranked list carries the addressing string the connector must send", () => {
  it("fills reservationId and addressingModel on the reserved entry only", () => {
    const draft = computeRankedList(
      "default",
      {
        providers: [FAST, CHEAP],
        observations: {
          "sim-a": observation("sim-a", 0.004, 200),
          "sim-b": observation("sim-b", 0.0005, 200),
        },
        workload: workloadWith(),
        liveReservations: [reservation()],
      },
      { unmetDimension: null, computedAtMs: NOW },
    );

    assert.deepEqual(
      draft.providers.map((entry) => [entry.providerId, entry.reservationId, entry.addressingModel]),
      [
        ["sim-a", "acme-fast-1", ARN],
        ["sim-b", null, null],
      ],
    );
  });
});

// ---------------------------------------------------------------------------
// Unaddressed capacity
// ---------------------------------------------------------------------------

function usage(overrides: Partial<ConnectorUsageRecord> = {}): ConnectorUsageRecord {
  return {
    workload: "default",
    providerId: "sim-a",
    model: "sim-fast",
    region: "local",
    promptTokens: 100,
    completionTokens: 200,
    latencyMs: 210,
    statusCode: 200,
    rateLimitLimit: null,
    rateLimitReset: null,
    reservationId: null,
    atMs: NOW - 1_000,
    ...overrides,
  };
}

describe("a declared reservation that traffic ignores is reported with its cause", () => {
  it("names the call site passing the foundation model instead of the provisioned one", () => {
    const [report] = unaddressedCapacity(
      [reservation()],
      [usage(), usage(), usage()],
      [FAST, CHEAP],
      NOW,
    );

    assert.ok(report !== undefined);
    assert.equal(report.addressableRequests, 3);
    assert.equal(report.addressedRequests, 0);
    assert.equal(report.addressedShare, 0);
    assert.equal(report.unaddressedTokens, 900);
    assert.equal(report.cause, "call_site_used_foundation_model");
    assert.ok(
      report.detail.includes("sim-fast") && report.detail.includes(ARN),
      `the cause must name both identifiers so the customer knows what to change: ${report.detail}`,
    );
  });

  it("reports full utilization when the connector addressed it", () => {
    const [report] = unaddressedCapacity(
      [reservation()],
      [
        usage({ model: ARN, reservationId: "acme-fast-1" }),
        usage({ model: ARN, reservationId: "acme-fast-1" }),
      ],
      [FAST, CHEAP],
      NOW,
    );

    assert.ok(report !== undefined);
    assert.equal(report.addressedRequests, 2);
    assert.equal(report.addressedShare, 1);
    assert.equal(report.unaddressedTokens, 0);
  });

  it("does not blame the call site for a term that is not live", () => {
    const [report] = unaddressedCapacity(
      [reservation({ termStartMs: NOW + 1_000, termEndMs: NOW + 2_000 })],
      [usage()],
      [FAST, CHEAP],
      NOW,
    );

    assert.ok(report !== undefined);
    assert.equal(report.live, false);
    assert.equal(report.cause, "term_not_live");
  });

  it("ignores traffic on another host, which never had this capacity to skip", () => {
    const [report] = unaddressedCapacity(
      [reservation()],
      [usage({ providerId: "sim-b", model: "sim-cheap" })],
      [FAST, CHEAP],
      NOW,
    );

    assert.ok(report !== undefined);
    assert.equal(report.addressableRequests, 0);
    assert.equal(report.cause, "no_addressable_traffic");
  });
});

// ---------------------------------------------------------------------------
// The resource
// ---------------------------------------------------------------------------

const WINDOW_MS = 1_000;

function serviceConfig(storePath: string) {
  return {
    storePath,
    pollMs: 1_000_000,
    windowMs: WINDOW_MS,
    windowMinRequests: 2,
    sampleFloor: 2,
    providers: [FAST, CHEAP],
  };
}

function withStore(run: (storePath: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "gateway-reservations-"));
  const storePath = join(dir, "store.sqlite");
  return (async () => {
    try {
      await run(storePath);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  })();
}

function putReservations(service: TargetService, version: number, reservations: unknown[]) {
  return handleManagementRequest(
    {
      method: "PUT",
      path: "/v1/reservations",
      body: JSON.stringify({ version, reservations }),
    },
    service,
    NOW,
  );
}

function putTargets(service: TargetService, version: number, workloads: unknown) {
  return handleManagementRequest(
    { method: "PUT", path: "/v1/targets", body: JSON.stringify({ version, workloads }) },
    service,
    NOW,
  );
}

describe("the reservation resource is versioned like the target document", () => {
  it("returns 409 on a second PUT with the same version, and keeps the first write", async () => {
    await withStore((storePath) => {
      const service = TargetService.start(serviceConfig(storePath), { nowMs: () => NOW });
      try {
        const first = putReservations(service, 0, [wire()]);
        assert.equal(first.status, 200);
        assert.equal(JSON.parse(first.body).version, 1);

        const second = putReservations(service, 0, [wire({ id: "acme-fast-2" })]);
        assert.equal(second.status, 409);
        const conflict = JSON.parse(second.body);
        assert.equal(conflict.currentVersion, 1);

        // Terminal, and the loser changed nothing: the client re-reads and re-decides.
        const read = handleManagementRequest(
          { method: "GET", path: "/v1/reservations", body: "" },
          service,
          NOW,
        );
        assert.equal(read.status, 200);
        const body = JSON.parse(read.body);
        assert.equal(body.version, 1);
        assert.deepEqual(
          body.reservations.reservations.map((entry: { id: string }) => entry.id),
          ["acme-fast-1"],
        );
      } finally {
        service.stop();
      }
    });
  });

  it("is a different document from the target document, versioned independently", async () => {
    await withStore((storePath) => {
      const service = TargetService.start(serviceConfig(storePath), { nowMs: () => NOW });
      try {
        assert.equal(putReservations(service, 0, [wire()]).status, 200);
        // A reservation write must not move the version of the document the customer
        // authored their targets in; that is the Decision Log's separation, mechanically.
        assert.equal(service.version, 0);

        assert.equal(
          putTargets(service, 0, {
            default: { allowed_models: ["sim-fast@sim-a"], objective: "none" },
          }).status,
          200,
        );
        assert.equal(service.version, 1);
        assert.equal(service.reservationVersion, 1);
      } finally {
        service.stop();
      }
    });
  });

  it("rejects a malformed reservation with 400 rather than storing it", async () => {
    await withStore((storePath) => {
      const service = TargetService.start(serviceConfig(storePath), { nowMs: () => NOW });
      try {
        const response = putReservations(service, 0, [wire({ addressingModel: "" })]);
        assert.equal(response.status, 400);
        assert.equal(service.reservationVersion, 0);
      } finally {
        service.stop();
      }
    });
  });
});

describe("the status resource reports unaddressed capacity with its cause", () => {
  it("shows the gap for a reservation the sample application's traffic walked past", async () => {
    await withStore((storePath) => {
      const service = TargetService.start(serviceConfig(storePath), { nowMs: () => NOW });
      try {
        assert.equal(
          putTargets(service, 0, {
            default: { allowed_models: ["sim-fast@sim-a", "sim-cheap@sim-b"], objective: "none" },
          }).status,
          200,
        );
        assert.equal(putReservations(service, 0, [wire()]).status, 200);

        // The connector reports what it actually called. Nothing here is measured from the
        // provider: Azure Monitor lags a five-minute window by up to fifteen minutes and
        // Bedrock publishes no utilization figure at all.
        const store = service.storeFor(DEFAULT_CUSTOMER_ID);
        assert.ok(store !== null);
        store.writeConnectorUsage([usage(), usage()]);

        const response = handleManagementRequest(
          { method: "GET", path: "/v1/workloads/default/status", body: "" },
          service,
          NOW,
        );
        assert.equal(response.status, 200);
        const [report] = JSON.parse(response.body).reservations;
        assert.equal(report.reservationId, "acme-fast-1");
        assert.equal(report.addressedRequests, 0);
        assert.equal(report.cause, "call_site_used_foundation_model");
        assert.ok(report.detail.includes(ARN));
      } finally {
        service.stop();
      }
    });
  });

  it("reports an empty list, never a missing field, when none are declared", async () => {
    await withStore((storePath) => {
      const service = TargetService.start(serviceConfig(storePath), { nowMs: () => NOW });
      try {
        assert.equal(
          putTargets(service, 0, {
            default: { allowed_models: ["sim-fast@sim-a"], objective: "none" },
          }).status,
          200,
        );
        const response = handleManagementRequest(
          { method: "GET", path: "/v1/workloads/default/status", body: "" },
          service,
          NOW,
        );
        assert.deepEqual(JSON.parse(response.body).reservations, []);
      } finally {
        service.stop();
      }
    });
  });
});

describe("the stub reports a distinct model when addressed by the provisioned identifier", () => {
  it("serves both identifiers and differs only in what it says it served", async () => {
    const sim = createSimProvider({
      name: "sim-a",
      profile: { latencyMs: 0, jitterMs: 0, costPer1kTokensUsd: 0.004, errorRate: 0 },
      addressingModel: ARN,
    });
    await new Promise<void>((done) => sim.listen(0, "127.0.0.1", done));
    const address = sim.address();
    assert.ok(address !== null && typeof address === "object");
    const base = `http://127.0.0.1:${address.port}/v1/chat/completions`;

    try {
      const call = async (model: string): Promise<Response> =>
        fetch(base, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, messages: [] }),
        });

      // The foundation identifier is answered normally — which is exactly why the mistake is
      // invisible from the call site, and why the gap has to be reported rather than thrown.
      const onDemand = await call("sim-fast");
      assert.equal(onDemand.headers.get(SIM_PROVIDER_HEADER), "sim-a");
      assert.equal(onDemand.headers.get(SIM_ADDRESSED_HEADER), null);
      await onDemand.arrayBuffer();

      const reserved = await call(ARN);
      assert.equal(reserved.headers.get(SIM_PROVIDER_HEADER), "sim-a-provisioned");
      assert.equal(reserved.headers.get(SIM_ADDRESSED_HEADER), ARN);
      assert.equal(((await reserved.json()) as { model: string }).model, "sim-a-provisioned");
    } finally {
      await new Promise<void>((done) => sim.close(() => done()));
    }
  });
});

describe("no provider credential is anywhere in the reservation path", () => {
  it("accepts no credential field on a reservation and stores none", async () => {
    // The reservation is the closest the gateway ever comes to holding provider account
    // detail — it names an ARN and a deployment. The key list is closed, so a customer who
    // tried to hand over a key would be rejected rather than have it quietly persisted.
    assert.throws(
      () => parseReservationDocument({ reservations: [wire({ apiKey: "sk-live-abc" })] }, 1),
      (error: unknown) => error instanceof ReservationDocumentError,
    );

    await withStore((storePath) => {
      const service = TargetService.start(serviceConfig(storePath), { nowMs: () => NOW });
      try {
        assert.equal(putReservations(service, 0, [wire()]).status, 200);
        const stored = JSON.stringify(
          serializeReservationDocument(service.reservationDocument() ?? {
            version: 0,
            reservations: [],
          }),
        );
        for (const forbidden of ["apiKey", "api_key", "secret", "password", "credential"]) {
          assert.ok(!stored.includes(forbidden), `${forbidden} must not be storable`);
        }
      } finally {
        service.stop();
      }
    });
  });
});

describe("a declared reservation reaches the routing snapshot and expires with the term", () => {
  it("is live inside the term and absent outside it", async () => {
    await withStore((storePath) => {
      let now = NOW;
      const service = TargetService.start(serviceConfig(storePath), { nowMs: () => now });
      try {
        assert.equal(
          putTargets(service, 0, {
            default: { allowed_models: ["sim-fast@sim-a", "sim-cheap@sim-b"], objective: "none" },
          }).status,
          200,
        );
        assert.equal(
          putReservations(service, 0, [wire({ termEndMs: NOW + 5_000 })]).status,
          200,
        );

        assert.equal(service.providerState("default").liveReservations?.length, 1);
        assert.equal(
          computeRankedList("default", service.providerState("default"), {
            unmetDimension: null,
            computedAtMs: now,
          }).providers[0]?.addressingModel,
          ARN,
        );

        // No write, no configuration change: the term simply ends.
        now = NOW + 6_000;
        assert.equal(service.providerState("default").liveReservations?.length, 0);
        assert.equal(
          computeRankedList("default", service.providerState("default"), {
            unmetDimension: null,
            computedAtMs: now,
          }).providers.every((entry) => entry.addressingModel === null),
          true,
        );
      } finally {
        service.stop();
      }
    });
  });
});
