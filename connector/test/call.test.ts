import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Server } from "node:http";

import { createCaller } from "../src/call.js";
import { TARGET_UNMET_HEADER } from "../src/headers.js";
import type { RankedList } from "../src/types.js";
import { close, collector, listen, rankedList, rankedProvider, stubProvider } from "./helpers.js";

function source(list: RankedList | null): { current(): RankedList | null } {
  return { current: (): RankedList | null => list };
}

/**
 * The connector's one routing rule, and the boundary around it.
 *
 * These tests exist to pin down what the request path must *not* do as much as what it
 * must: no target is evaluated anywhere here, and the only thing that moves traffic is the
 * ordering the gateway pushed.
 */
describe("the request path's single routing rule", () => {
  for (const status of [429, 500, 503]) {
    it(`fails over to the next provider on ${status}`, async () => {
      const first = stubProvider({ name: "first", status });
      const second = stubProvider({ name: "second" });
      const firstUrl = await listen(first);
      const secondUrl = await listen(second);
      const usage = collector();

      try {
        const call = createCaller({
          lists: source(
            rankedList({
              providers: [
                rankedProvider({ providerId: "first", baseUrl: firstUrl }),
                rankedProvider({ providerId: "second", baseUrl: secondUrl }),
              ],
            }),
          ),
          usage,
          fallback: rankedProvider({ baseUrl: "http://127.0.0.1:1" }),
          defaultWorkload: "default",
        });

        const response = await call({ model: "sim", messages: [] });

        assert.equal(response.status, 200);
        assert.equal(response.providerId, "second");
        assert.equal(first.calls(), 1, "the failing provider must be tried exactly once");
        assert.equal(second.calls(), 1);
        assert.deepEqual(
          usage.records.map((record) => record.statusCode),
          [status, 200],
          "the failed attempt is reported too — a 429 is evidence, not an absence",
        );
      } finally {
        await close(first);
        await close(second);
      }
    });
  }

  it("fails over on a network error and reports it as status 0", async () => {
    const dead = stubProvider({ name: "dead" });
    const deadUrl = await listen(dead);
    await close(dead);

    const live = stubProvider({ name: "live" });
    const liveUrl = await listen(live);
    const usage = collector();

    try {
      const call = createCaller({
        lists: source(
          rankedList({
            providers: [
              rankedProvider({ providerId: "dead", baseUrl: deadUrl }),
              rankedProvider({ providerId: "live", baseUrl: liveUrl }),
            ],
          }),
        ),
        usage,
        fallback: rankedProvider({ baseUrl: "http://127.0.0.1:1" }),
        defaultWorkload: "default",
      });

      const response = await call({ model: "sim", messages: [] });

      assert.equal(response.providerId, "live");
      assert.equal(usage.records[0]?.statusCode, 0);
    } finally {
      await close(live);
    }
  });

  it("throws only when every provider in the list failed with a transport error", async () => {
    const dead = stubProvider({ name: "dead" });
    const deadUrl = await listen(dead);
    await close(dead);

    const call = createCaller({
      lists: source(
        rankedList({ providers: [rankedProvider({ providerId: "dead", baseUrl: deadUrl })] }),
      ),
      usage: collector(),
      fallback: rankedProvider({ baseUrl: deadUrl }),
      defaultWorkload: "default",
    });

    await assert.rejects(() => call({ model: "sim", messages: [] }));
  });

  it("returns the last provider's error rather than throwing when one answered", async () => {
    const failing = stubProvider({ name: "failing", status: 503 });
    const url = await listen(failing);

    try {
      const call = createCaller({
        lists: source(
          rankedList({ providers: [rankedProvider({ providerId: "only", baseUrl: url })] }),
        ),
        usage: collector(),
        fallback: rankedProvider({ baseUrl: url }),
        defaultWorkload: "default",
      });

      const response = await call({ model: "sim", messages: [] });
      assert.equal(response.status, 503);
    } finally {
      await close(failing);
    }
  });
});

describe("the connector before its first list", () => {
  it("calls the statically configured fallback provider", async () => {
    const fallback = stubProvider({ name: "fallback" });
    const url = await listen(fallback);
    const usage = collector();

    try {
      const call = createCaller({
        lists: source(null),
        usage,
        fallback: rankedProvider({ providerId: "fallback", baseUrl: url, model: "fallback" }),
        defaultWorkload: "default",
      });

      const response = await call({ model: "sim", messages: [] });

      assert.equal(response.providerId, "fallback");
      assert.equal(fallback.calls(), 1);
      assert.equal(usage.records[0]?.promptTokens, 3, "token counts come from the provider");
      assert.equal(usage.records[0]?.completionTokens, 7);
    } finally {
      await close(fallback);
    }
  });
});

describe("what the connector puts on the wire and on the record", () => {
  it("rewrites the model with the entry's addressing model and records the reservation", async () => {
    const provider = stubProvider({ name: "reserved" });
    const url = await listen(provider);
    const usage = collector();

    try {
      const call = createCaller({
        lists: source(
          rankedList({
            providers: [
              rankedProvider({
                providerId: "reserved",
                baseUrl: url,
                model: "claude-sonnet-5",
                addressingModel: "arn:aws:bedrock:us-east-1:1:provisioned-model/abc",
                reservationId: "acme-bedrock-1",
              }),
            ],
          }),
        ),
        usage,
        fallback: rankedProvider({ baseUrl: url }),
        defaultWorkload: "default",
      });

      await call({ model: "claude-sonnet-5", messages: [] });

      const sent = JSON.parse(provider.bodies()[0] ?? "{}") as { model?: string };
      assert.equal(sent.model, "arn:aws:bedrock:us-east-1:1:provisioned-model/abc");
      assert.equal(usage.records[0]?.reservationId, "acme-bedrock-1");
    } finally {
      await close(provider);
    }
  });

  it("carries the provider's rate-limit headers onto the record unparsed", async () => {
    const provider = stubProvider({
      name: "limited",
      status: 429,
      headers: { "x-ratelimit-limit-requests": "500", "retry-after": "12" },
    });
    const url = await listen(provider);
    const usage = collector();

    try {
      const call = createCaller({
        lists: source(
          rankedList({ providers: [rankedProvider({ providerId: "limited", baseUrl: url })] }),
        ),
        usage,
        fallback: rankedProvider({ baseUrl: url }),
        defaultWorkload: "default",
      });

      await call({ model: "sim", messages: [] });

      assert.equal(usage.records[0]?.rateLimitLimit, "500");
      assert.equal(usage.records[0]?.rateLimitReset, "12");
    } finally {
      await close(provider);
    }
  });

  it("sets the unmet header when the pushed list says the target is not held", async () => {
    const provider: Server & { calls(): number } = stubProvider({ name: "sim" });
    const url = await listen(provider);

    try {
      const call = createCaller({
        lists: source(
          rankedList({
            unmetDimension: "p95_ms",
            providers: [rankedProvider({ providerId: "sim", baseUrl: url })],
          }),
        ),
        usage: collector(),
        fallback: rankedProvider({ baseUrl: url }),
        defaultWorkload: "default",
      });

      const held = await call({ model: "sim", messages: [] });
      assert.equal(held.headers[TARGET_UNMET_HEADER], "p95_ms");
    } finally {
      await close(provider);
    }
  });

  it("omits the unmet header when the workload is holding its target", async () => {
    const provider = stubProvider({ name: "sim" });
    const url = await listen(provider);

    try {
      const call = createCaller({
        lists: source(
          rankedList({ providers: [rankedProvider({ providerId: "sim", baseUrl: url })] }),
        ),
        usage: collector(),
        fallback: rankedProvider({ baseUrl: url }),
        defaultWorkload: "default",
      });

      const response = await call({ model: "sim", messages: [] });
      assert.equal(response.headers[TARGET_UNMET_HEADER], undefined);
    } finally {
      await close(provider);
    }
  });
});
