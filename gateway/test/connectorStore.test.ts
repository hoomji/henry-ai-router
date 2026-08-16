import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ackDelayMs, TargetStore } from "../src/targets/store.js";
import type { ConnectorUsageRecord } from "../src/targets/store.js";
import type { TargetDocument } from "../src/types.js";

/**
 * Same isolation as `store.test.ts`: a leaked file between tests would look exactly like
 * the cross-customer leakage these tests exist to rule out.
 */
let directories = 0;
function withStorePath(body: (path: string) => void): void {
  const directory = mkdtempSync(
    join(tmpdir(), `gateway-connector-${process.pid}-${directories++}-`),
  );
  try {
    body(join(directory, "targets.db"));
  } finally {
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

function usageFrom(overrides: Partial<ConnectorUsageRecord>): ConnectorUsageRecord {
  return {
    workload: "default",
    providerId: "sim-a",
    model: "sim-a",
    region: "local",
    promptTokens: 12,
    completionTokens: 40,
    latencyMs: 210,
    statusCode: 200,
    rateLimitLimit: null,
    rateLimitReset: null,
    reservationId: null,
    atMs: 1_755_216_000_000,
    ...overrides,
  };
}

describe("connector tokens", () => {
  it("mints a token that resolves back to the customer it was minted for", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        const acme = store.forCustomer("acme");
        const minted = acme.mintConnector(1_000);

        assert.equal(minted.customerId, "acme");
        assert.equal(minted.createdAtMs, 1_000);
        assert.match(minted.token, /^[0-9a-f]{64}$/, "32 bytes of randomness, hex encoded");
        assert.equal(store.resolveConnectorCustomer(minted.token), "acme");
      } finally {
        store.close();
      }
    });
  });

  it("resolves an unknown token to null rather than throwing", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        // An unknown token is an ordinary 401, not a store failure, so the caller must be
        // able to tell the two apart without catching.
        assert.equal(store.resolveConnectorCustomer("not-a-token"), null);
      } finally {
        store.close();
      }
    });
  });

  it("mints a distinct token each time, so revoking one leaves the other working", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        const acme = store.forCustomer("acme");
        const first = acme.mintConnector(1_000);
        const second = acme.mintConnector(2_000);
        assert.notEqual(first.token, second.token);

        assert.equal(acme.revokeConnector(first.token), true);
        assert.equal(
          store.resolveConnectorCustomer(first.token),
          null,
          "revocation is deletion: the very next request stops resolving",
        );
        assert.equal(
          store.resolveConnectorCustomer(second.token),
          "acme",
          "a rollout runs two connectors side by side, so revoking one must not revoke both",
        );
      } finally {
        store.close();
      }
    });
  });

  it("refuses to revoke another customer's token", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        const acme = store.forCustomer("acme");
        const other = store.forCustomer("globex");
        const token = acme.mintConnector(1_000).token;

        assert.equal(other.revokeConnector(token), false);
        assert.equal(
          store.resolveConnectorCustomer(token),
          "acme",
          "an admin acting for one customer must not be able to revoke another's connector",
        );
      } finally {
        store.close();
      }
    });
  });

  it("lists only the minting customer's connectors", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        store.forCustomer("acme").mintConnector(1_000);
        store.forCustomer("globex").mintConnector(2_000);

        assert.deepEqual(
          store.forCustomer("acme").listConnectors().map((c) => c.customerId),
          ["acme"],
        );
      } finally {
        store.close();
      }
    });
  });
});

describe("customer scoping of the store", () => {
  it("keeps one customer's target document invisible to another", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        const acme = store.forCustomer("acme");
        const globex = store.forCustomer("globex");

        assert.deepEqual(acme.writeDocument(0, documentWith("https://acme.invalid"), null), {
          ok: true,
          version: 1,
        });

        // The proof that the scope is real and not decorative: globex's version is
        // untouched by acme's write, so its own first write is still against version 0.
        assert.equal(globex.readDocument(), null);
        assert.equal(globex.readVersion(), 0);
        assert.deepEqual(globex.writeDocument(0, documentWith("https://globex.invalid"), null), {
          ok: true,
          version: 1,
        });

        assert.equal(acme.readDocument()?.notifyUrl, "https://acme.invalid");
        assert.equal(globex.readDocument()?.notifyUrl, "https://globex.invalid");
        assert.equal(
          store.readDocument(),
          null,
          "neither customer's write may land on the default scope the pre-auth callers use",
        );
      } finally {
        store.close();
      }
    });
  });

  it("keeps unmet state, summaries, and usage from crossing between customers", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        const acme = store.forCustomer("acme");
        const globex = store.forCustomer("globex");

        acme.writeWindowSummary({
          workload: "default",
          providerId: "sim-a",
          processId: "p1",
          openedAtMs: 1_000,
          closedAtMs: 2_000,
          latenciesMs: [10],
          successCount: 1,
          requestCount: 1,
          costPer1kTokensUsdSum: 0.01,
        });
        acme.writeConnectorUsage([usageFrom({ promptTokens: 100 })]);
        acme.casUnmetState(
          "default",
          null,
          {
            workload: "default",
            unmet: true,
            since: 5,
            report: null,
            missedStreak: 1,
            heldStreak: 0,
            lastWindowAtMs: 5,
          },
        );

        assert.deepEqual(globex.readWindowSummaries("default", 0), []);
        assert.deepEqual(globex.readConnectorUsage(0), []);
        assert.equal(
          globex.readUnmetState("default"),
          null,
          "one customer entering unmet must not notify another customer's webhook",
        );

        assert.equal(acme.readWindowSummaries("default", 0).length, 1);
        assert.equal(acme.readConnectorUsage(0).length, 1);
        assert.equal(acme.readUnmetState("default")?.unmet, true);
      } finally {
        store.close();
      }
    });
  });

  it("makes a query that omits the customer fail rather than read across customers", () => {
    // The scoping is mechanical only because `node:sqlite` rejects a named parameter the
    // statement does not mention: the store binds `$customer` on every query, so SQL that
    // forgets `customer_id = $customer` throws the first time it runs instead of quietly
    // returning every customer's rows. This pins that runtime guarantee, which is the one
    // assumption the whole design rests on and the one thing a Node upgrade could remove.
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE scoped (customer_id TEXT NOT NULL, value INTEGER NOT NULL)`);
      db.prepare(`INSERT INTO scoped VALUES ($customer, 1)`).run({ customer: "acme" });
      assert.throws(
        () => db.prepare(`SELECT value FROM scoped`).all({ customer: "acme" }),
        /Unknown named parameter/,
      );
    } finally {
      db.close();
    }
  });

  it("leaves the default customer as the one pre-authentication callers see", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        assert.equal(store.customerId, "default");
        assert.equal(store.forCustomer("default"), store, "the default scope is not a copy");
      } finally {
        store.close();
      }
    });
  });

  it("survives a scoped view being closed, since the view does not own the handle", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        const acme = store.forCustomer("acme");
        acme.mintConnector(1_000);
        acme.close();
        assert.equal(store.readVersion(), 0, "the owner's handle must still be usable");
      } finally {
        store.close();
      }
    });
  });
});

describe("connector directives", () => {
  it("round-trips a push and its acknowledgement with a computable delay", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        const acme = store.forCustomer("acme");
        acme.recordDirectiveDelivery("default", 7, "push", 10_000);
        assert.equal(acme.recordDirectiveAck("default", 7, 10_120), true);

        const directive = acme.readDirective("default");
        assert.deepEqual(directive, {
          workload: "default",
          pushedVersion: 7,
          pushedAtMs: 10_000,
          ackedVersion: 7,
          ackedAtMs: 10_120,
          deliveryMode: "push",
        });
        assert.equal(ackDelayMs(directive!), 120);
      } finally {
        store.close();
      }
    });
  });

  it("shows a polled list as acknowledged far later than a pushed one", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        const acme = store.forCustomer("acme");

        // The version became available at the same instant in both cases; what differs is
        // how long the connector took to adopt it, and that gap is the whole diagnosis.
        acme.recordDirectiveDelivery("fast", 1, "push", 0);
        acme.recordDirectiveAck("fast", 1, 90);
        acme.recordDirectiveDelivery("slow", 1, "poll", 0);
        acme.recordDirectiveAck("slow", 1, 14_500);

        const fast = acme.readDirective("fast");
        const slow = acme.readDirective("slow");
        assert.equal(fast?.deliveryMode, "push");
        assert.equal(slow?.deliveryMode, "poll");
        assert.equal(ackDelayMs(fast!), 90);
        assert.equal(ackDelayMs(slow!), 14_500);
      } finally {
        store.close();
      }
    });
  });

  it("pins the delivery instant to the first offer of a version, not the latest", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        const acme = store.forCustomer("acme");
        acme.recordDirectiveDelivery("default", 4, "push", 1_000);
        // The connector reconnected and was handed the same version again. Re-stamping the
        // instant here would erase the delay the ack is supposed to reveal.
        acme.recordDirectiveDelivery("default", 4, "poll", 9_000);

        const directive = acme.readDirective("default");
        assert.equal(directive?.pushedAtMs, 1_000);
        assert.equal(directive?.deliveryMode, "poll", "the latest mode is the current one");
      } finally {
        store.close();
      }
    });
  });

  it("reports no adoption while the acknowledgement lags the outstanding version", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        const acme = store.forCustomer("acme");
        acme.recordDirectiveDelivery("default", 1, "push", 0);
        acme.recordDirectiveAck("default", 1, 50);
        acme.recordDirectiveDelivery("default", 2, "push", 1_000);

        const directive = acme.readDirective("default");
        assert.equal(directive?.pushedVersion, 2);
        assert.equal(directive?.ackedVersion, 1, "the stale ack stays visible as a mismatch");
        assert.equal(
          ackDelayMs(directive!),
          null,
          "a delay for a superseded version would read as agreement with the current list",
        );
      } finally {
        store.close();
      }
    });
  });

  it("refuses an acknowledgement for a workload nothing was delivered for", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        const acme = store.forCustomer("acme");
        assert.equal(
          acme.recordDirectiveAck("never-sent", 3, 100),
          false,
          "the caller answers 404 rather than inventing a row for a list it never sent",
        );
        assert.equal(acme.readDirective("never-sent"), null);
      } finally {
        store.close();
      }
    });
  });

  it("keeps one customer's directives out of another's", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        store.forCustomer("acme").recordDirectiveDelivery("default", 7, "push", 10_000);
        assert.deepEqual(store.forCustomer("globex").readDirectives(), []);
        assert.deepEqual(
          store.forCustomer("acme").readDirectives().map((d) => d.pushedVersion),
          [7],
        );
      } finally {
        store.close();
      }
    });
  });
});

describe("connector usage records", () => {
  it("round-trips a reported batch whole, including the absent fields", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        const acme = store.forCustomer("acme");
        const record = usageFrom({
          statusCode: 429,
          rateLimitLimit: "10000",
          rateLimitReset: "60s",
          reservationId: "acme-bedrock-1",
        });
        acme.writeConnectorUsage([record, usageFrom({ atMs: 1_755_216_000_001 })]);

        const [first, second] = acme.readConnectorUsage(0);
        assert.deepEqual(first, record);
        assert.equal(
          second?.rateLimitLimit,
          null,
          "a provider that sent no rate-limit header must not be stored as one that sent an empty one",
        );
      } finally {
        store.close();
      }
    });
  });

  it("writes nothing and does not fail on an empty batch", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        store.writeConnectorUsage([]);
        assert.deepEqual(store.readConnectorUsage(0), []);
      } finally {
        store.close();
      }
    });
  });

  it("returns only the records at or after the requested time", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        store.writeConnectorUsage([usageFrom({ atMs: 1_000 }), usageFrom({ atMs: 5_000 })]);
        assert.deepEqual(
          store.readConnectorUsage(5_000).map((r) => r.atMs),
          [5_000],
        );
      } finally {
        store.close();
      }
    });
  });

  it("aggregates token counts per workload", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        store.writeConnectorUsage([
          usageFrom({ workload: "default", promptTokens: 10, completionTokens: 1, atMs: 100 }),
          usageFrom({ workload: "default", promptTokens: 20, completionTokens: 2, atMs: 200 }),
          usageFrom({ workload: "batch", promptTokens: 5, completionTokens: 3, atMs: 300 }),
        ]);

        // These counts are the ones only the connector could have supplied: the gateway
        // never saw any of these calls.
        assert.deepEqual(store.readUsageTotals(0), [
          { workload: "batch", requestCount: 1, promptTokens: 5, completionTokens: 3 },
          { workload: "default", requestCount: 2, promptTokens: 30, completionTokens: 3 },
        ]);
        assert.deepEqual(store.readUsageTotals(200), [
          { workload: "batch", requestCount: 1, promptTokens: 5, completionTokens: 3 },
          { workload: "default", requestCount: 1, promptTokens: 20, completionTokens: 2 },
        ]);
      } finally {
        store.close();
      }
    });
  });

  it("prunes only the records older than the cutoff", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        store.writeConnectorUsage([
          usageFrom({ atMs: 1_000, providerId: "old" }),
          usageFrom({ atMs: 9_000, providerId: "new" }),
        ]);

        store.pruneConnectorUsage(5_000);

        assert.deepEqual(
          store.readConnectorUsage(0).map((r) => r.providerId),
          ["new"],
          "this table is evidence for a rolling window, not a ledger",
        );
      } finally {
        store.close();
      }
    });
  });

  it("prunes one customer's records without touching another's", () => {
    withStorePath((path) => {
      const store = TargetStore.open(path);
      try {
        store.forCustomer("acme").writeConnectorUsage([usageFrom({ atMs: 1_000 })]);
        store.forCustomer("globex").writeConnectorUsage([usageFrom({ atMs: 1_000 })]);

        store.forCustomer("acme").pruneConnectorUsage(5_000);

        assert.equal(store.forCustomer("acme").readConnectorUsage(0).length, 0);
        assert.equal(store.forCustomer("globex").readConnectorUsage(0).length, 1);
      } finally {
        store.close();
      }
    });
  });
});
