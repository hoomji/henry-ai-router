import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Config } from "../src/config.js";
import { handleManagementRequest } from "../src/management/api.js";
import { CATALOGUE_EPOCH_MS } from "../src/providers/capabilities.js";
import { createGateway } from "../src/server.js";
import { TargetService } from "../src/targets/service.js";
import type { StatusResource } from "../src/targets/service.js";
import type { Provider } from "../src/types.js";

/**
 * The connector-facing surface, over a real socket on an ephemeral port.
 *
 * These go through HTTP rather than calling the handler because what is under test here is
 * exactly the part that could not be expressed as a returned value: a response that stays
 * open, its frames, and its cleanup. Everything that *could* be a pure function is tested as
 * one in `rankedList.test.ts`.
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

/** The debounce is 40x shorter than production so a push is observable inside a test. */
const PUSH_DEBOUNCE_MS = 25;

const BOTH_PROVIDERS = {
  default: {
    allowed_models: ["sim-fast@sim-a", "sim-cheap@sim-b"],
    p95_ms: 300,
    objective: "cost_per_1k_tokens_usd",
  },
};

const ONE_PROVIDER = {
  default: {
    allowed_models: ["sim-fast@sim-a"],
    p95_ms: 300,
    objective: "cost_per_1k_tokens_usd",
  },
};

interface Harness {
  readonly baseUrl: string;
  readonly service: TargetService;
  /** A minted token for customer `default`, which is the customer management reads. */
  readonly token: string;
  put(version: number, workloads: unknown): void;
  status(workload: string): StatusResource;
}

function config(storePath: string, overrides: Partial<Config> = {}): Config {
  return {
    upstreamBaseUrl: "http://upstream.invalid",
    port: 0,
    forceRouterError: false,
    storePath,
    notifySecret: null,
    pollMs: 1_000_000,
    windowMs: WINDOW_MS,
    windowMinRequests: 2,
    sampleFloor: 2,
    notifyRetryMs: 1_000,
    providers: [FAST, SLOW_CHEAP],
    adminToken: "admin-secret",
    pushDebounceMs: PUSH_DEBOUNCE_MS,
    sseDisabled: false,
    ...overrides,
  };
}

async function withGateway(
  overrides: Partial<Config>,
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "gateway-cp-"));
  const storePath = join(dir, "store.sqlite");
  const nowMs = CATALOGUE_EPOCH_MS;
  const resolved = config(storePath, overrides);
  const service = TargetService.start(
    {
      storePath,
      pollMs: resolved.pollMs,
      windowMs: resolved.windowMs,
      windowMinRequests: resolved.windowMinRequests,
      sampleFloor: resolved.sampleFloor,
      providers: resolved.providers,
    },
    { nowMs: () => nowMs },
  );
  const server = createGateway(resolved, { service });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const harness: Harness = {
    baseUrl,
    service,
    token: service.storeFor("default")?.mintConnector(nowMs).token ?? "",
    put(version, workloads) {
      const response = handleManagementRequest(
        { method: "PUT", path: "/v1/targets", body: JSON.stringify({ version, workloads }) },
        service,
        nowMs,
      );
      assert.equal(response.status, 200, `target write rejected: ${response.body}`);
    },
    status(workload) {
      const response = handleManagementRequest(
        { method: "GET", path: `/v1/workloads/${workload}/status`, body: "" },
        service,
        nowMs,
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

/** Reads `event: list` frames off a live stream, skipping the comment heartbeats. */
class FrameReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";

  constructor(body: ReadableStream<Uint8Array>) {
    this.#reader = body.getReader();
  }

  async next(): Promise<Record<string, unknown>> {
    for (;;) {
      const boundary = this.#buffer.indexOf("\n\n");
      if (boundary === -1) {
        const chunk = await this.#reader.read();
        if (chunk.done) throw new Error("stream ended before a frame arrived");
        this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
        continue;
      }

      const frame = this.#buffer.slice(0, boundary);
      this.#buffer = this.#buffer.slice(boundary + 2);
      if (frame.startsWith(":")) continue;

      const lines = frame.split("\n");
      assert.equal(lines[0], "event: list", `unexpected frame: ${frame}`);
      const data = lines[1] ?? "";
      assert.ok(data.startsWith("data: "), `frame carried no data line: ${frame}`);
      return JSON.parse(data.slice("data: ".length)) as Record<string, unknown>;
    }
  }

  async cancel(): Promise<void> {
    await this.#reader.cancel().catch(() => undefined);
  }
}

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe("every connector endpoint requires a bearer token", () => {
  it("answers 401 without one, and with an unknown one", async () => {
    await withGateway({}, async ({ baseUrl }) => {
      for (const path of [
        "/v1/connector/stream",
        "/v1/connector/lists",
        "/v1/connector/ack",
        "/v1/connector/usage",
      ]) {
        const bare = await fetch(`${baseUrl}${path}`, { method: "POST", body: "{}" });
        assert.equal(bare.status, 401, `${path} served an unauthenticated caller`);
        assert.deepEqual(await bare.json(), { error: "unauthorized" });

        const wrong = await fetch(`${baseUrl}${path}`, {
          method: "POST",
          body: "{}",
          headers: auth("not-a-real-token"),
        });
        assert.equal(wrong.status, 401, `${path} accepted an unknown token`);
      }
    });
  });
});

describe("the admin mint is absent rather than open when it is unconfigured", () => {
  it("answers 404 when GATEWAY_ADMIN_TOKEN is unset", async () => {
    await withGateway({ adminToken: null }, async ({ baseUrl }) => {
      const response = await fetch(`${baseUrl}/v1/admin/connectors`, {
        method: "POST",
        body: JSON.stringify({ customerId: "acme" }),
        headers: auth("anything"),
      });
      assert.equal(response.status, 404, "an unconfigured mint must not be reachable");
    });
  });

  it("mints a token the connector endpoints then accept", async () => {
    await withGateway({}, async ({ baseUrl }) => {
      const refused = await fetch(`${baseUrl}/v1/admin/connectors`, {
        method: "POST",
        body: JSON.stringify({ customerId: "acme" }),
        headers: auth("wrong-admin-token"),
      });
      assert.equal(refused.status, 401);

      const response = await fetch(`${baseUrl}/v1/admin/connectors`, {
        method: "POST",
        body: JSON.stringify({ customerId: "acme" }),
        headers: auth("admin-secret"),
      });
      assert.equal(response.status, 201);
      const minted = (await response.json()) as { token: string; customerId: string };
      assert.equal(minted.customerId, "acme");
      assert.ok(minted.token.length > 0);

      const lists = await fetch(`${baseUrl}/v1/connector/lists`, { headers: auth(minted.token) });
      assert.equal(lists.status, 200, "the minted token authenticates the connector surface");
    });
  });
});

describe("the stream carries the current lists and every subsequent change", () => {
  it("bursts the current list on connect and pushes a new version when the target moves", async () => {
    await withGateway({}, async ({ baseUrl, token, put }) => {
      put(0, BOTH_PROVIDERS);

      const response = await fetch(`${baseUrl}/v1/connector/stream`, { headers: auth(token) });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "text/event-stream");
      assert.equal(response.headers.get("cache-control"), "no-cache");
      assert.ok(response.body !== null);

      const frames = new FrameReader(response.body);
      try {
        const first = await frames.next();
        assert.equal(first["workload"], "default");
        assert.equal(first["version"], 1, "the connect burst is version 1");
        assert.deepEqual(
          (first["providers"] as { providerId: string }[]).map((p) => p.providerId).sort(),
          ["sim-a", "sim-b"],
        );

        // A target change is one of the three things that must produce a push.
        put(1, ONE_PROVIDER);

        const second = await frames.next();
        assert.equal(second["version"], 2, "a changed list is a new version");
        assert.deepEqual(
          (second["providers"] as { providerId: string }[]).map((p) => p.providerId),
          ["sim-a"],
          "the pushed list reflects the narrowed allowed_models",
        );
      } finally {
        await frames.cancel();
      }
    });
  });

  it("answers 503 when the stream is disabled, so the polling mode is demonstrable", async () => {
    await withGateway({ sseDisabled: true }, async ({ baseUrl, token, put }) => {
      put(0, BOTH_PROVIDERS);
      const response = await fetch(`${baseUrl}/v1/connector/stream`, { headers: auth(token) });
      assert.equal(response.status, 503);

      const lists = await fetch(`${baseUrl}/v1/connector/lists`, { headers: auth(token) });
      assert.equal(lists.status, 200, "the fallback works while the stream is refused");
    });
  });
});

describe("the polling fallback serves the same lists and records the degraded mode", () => {
  it("returns the lists and marks the delivery mode poll", async () => {
    await withGateway({}, async ({ baseUrl, token, put, status }) => {
      put(0, BOTH_PROVIDERS);

      const response = await fetch(`${baseUrl}/v1/connector/lists`, { headers: auth(token) });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { lists: { workload: string; version: number }[] };
      assert.equal(body.lists.length, 1);
      assert.equal(body.lists[0]?.workload, "default");
      assert.equal(body.lists[0]?.version, 1);

      const directive = status("default").directive;
      assert.equal(directive?.deliveryMode, "poll", "a polled list is diagnosably polled");
      assert.equal(directive?.pushedVersion, 1);
      assert.equal(directive?.ackedVersion, null, "nothing has been acknowledged yet");
      assert.equal(directive?.ackDelayMs, null);
    });
  });
});

describe("an acknowledgement is what proves a list is in force", () => {
  it("records the ack and makes the adoption delay computable", async () => {
    await withGateway({}, async ({ baseUrl, token, put, status }) => {
      put(0, BOTH_PROVIDERS);
      await fetch(`${baseUrl}/v1/connector/lists`, { headers: auth(token) });

      const response = await fetch(`${baseUrl}/v1/connector/ack`, {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({ workload: "default", version: 1 }),
      });
      assert.equal(response.status, 204);

      const directive = status("default").directive;
      assert.equal(directive?.ackedVersion, 1);
      assert.ok(directive !== null && directive.ackDelayMs !== null, "the delay is computable");
      assert.ok((directive?.ackDelayMs ?? -1) >= 0);
    });
  });

  it("answers 404 for a workload no list was ever delivered for", async () => {
    await withGateway({}, async ({ baseUrl, token, put }) => {
      put(0, BOTH_PROVIDERS);
      const response = await fetch(`${baseUrl}/v1/connector/ack`, {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({ workload: "never-sent", version: 1 }),
      });
      assert.equal(response.status, 404);
    });
  });
});

describe("usage ingestion can never fail a customer's request path", () => {
  it("stores the good records in a batch and drops only the malformed one", async () => {
    await withGateway({}, async ({ baseUrl, token, put, status }) => {
      put(0, BOTH_PROVIDERS);

      const good = (promptTokens: number) => ({
        workload: "default",
        providerId: "sim-a",
        model: "sim-fast",
        region: "local",
        promptTokens,
        completionTokens: 40,
        latencyMs: 210,
        statusCode: 200,
        rateLimitLimit: null,
        rateLimitReset: null,
        reservationId: null,
        atMs: CATALOGUE_EPOCH_MS,
      });

      const response = await fetch(`${baseUrl}/v1/connector/usage`, {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({
          records: [
            good(12),
            // Malformed: a token count that is not a number would either break the batch's
            // transaction or corrupt the totals. It must be dropped by itself.
            { ...good(0), promptTokens: "lots" },
            good(30),
          ],
          strainDropped: 0,
          usageDropped: 0,
        }),
      });
      assert.equal(response.status, 204, "a malformed record must never 4xx the batch");

      const usage = status("default").usage;
      assert.equal(usage.requestCount, 2, "the two good records landed");
      assert.equal(usage.promptTokens, 42, "and only those two");
      assert.equal(usage.completionTokens, 80);
    });
  });

  it("acknowledges even a body it cannot parse rather than pushing failure back", async () => {
    await withGateway({}, async ({ baseUrl, token, put }) => {
      put(0, BOTH_PROVIDERS);
      const response = await fetch(`${baseUrl}/v1/connector/usage`, {
        method: "POST",
        headers: auth(token),
        body: "this is not json",
      });
      assert.equal(response.status, 204);
    });
  });
});

describe("the status resource reports what only the connector could have told us", () => {
  it("shows token counts and provider-attributable latency from the usage reports", async () => {
    await withGateway({}, async ({ baseUrl, token, put, status }) => {
      put(0, BOTH_PROVIDERS);

      const before = status("default").usage;
      assert.equal(before.requestCount, 0);
      assert.equal(before.providerLatencyP95Ms, "insufficient_data");

      const records = [];
      for (let i = 0; i < 10; i += 1) {
        records.push({
          workload: "default",
          providerId: "sim-b",
          model: "sim-cheap",
          region: "local",
          promptTokens: 10,
          completionTokens: 5,
          latencyMs: 100 + i,
          statusCode: 200,
          rateLimitLimit: null,
          rateLimitReset: null,
          reservationId: null,
          atMs: CATALOGUE_EPOCH_MS,
        });
      }
      const response = await fetch(`${baseUrl}/v1/connector/usage`, {
        method: "POST",
        headers: auth(token),
        body: JSON.stringify({ records, strainDropped: 0, usageDropped: 0 }),
      });
      assert.equal(response.status, 204);

      const usage = status("default").usage;
      assert.equal(usage.requestCount, 10);
      assert.equal(usage.promptTokens, 100, "the gateway never saw these tokens itself");
      assert.equal(usage.completionTokens, 50);
      assert.equal(
        usage.providerLatencyP95Ms,
        109,
        "the p95 of latencies the gateway could only have been told about",
      );
    });
  });
});
