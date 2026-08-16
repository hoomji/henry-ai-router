import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCaller } from "../src/call.js";
import type { RankedList } from "../src/types.js";
import { close, collector, listen, rankedList, rankedProvider, serve } from "./helpers.js";

const CHUNK_GAP_MS = 300;

/** A provider that emits three SSE chunks spaced apart, ending with a usage frame. */
function slowStreamingProvider(options: { withUsageFrame: boolean }) {
  return serve((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    res.write('data: {"choices":[{"delta":{"content":"one"}}]}\n\n');
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":"two"}}]}\n\n');
      setTimeout(() => {
        if (options.withUsageFrame) {
          res.write('data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":22}}\n\n');
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }, CHUNK_GAP_MS);
    }, CHUNK_GAP_MS);
  });
}

async function readWithTimings(
  stream: ReadableStream<Uint8Array>,
): Promise<{ firstAtMs: number; lastAtMs: number; text: string }> {
  const startedAtMs = Date.now();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let firstAtMs = -1;
  let text = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstAtMs === -1) firstAtMs = Date.now() - startedAtMs;
    text += decoder.decode(value, { stream: true });
  }
  return { firstAtMs, lastAtMs: Date.now() - startedAtMs, text };
}

/**
 * The test the plan singles out.
 *
 * A connector that quietly buffers a streamed body passes every other test in this suite —
 * the bytes are all correct, the tokens are all counted, the failover still works. Only
 * time-to-first-byte separates a relay from a buffer, so that is what is measured here.
 */
describe("streamed responses", () => {
  it("delivers the first chunk long before the last one is produced", async () => {
    const provider = slowStreamingProvider({ withUsageFrame: true });
    const url = await listen(provider);
    const usage = collector();

    try {
      const call = createCaller({
        lists: {
          current: (): RankedList =>
            rankedList({ providers: [rankedProvider({ providerId: "stream", baseUrl: url })] }),
        },
        usage,
        fallback: rankedProvider({ baseUrl: url }),
        defaultWorkload: "default",
      });

      const response = await call({ model: "sim", messages: [], stream: true });
      assert.notEqual(response.stream, null, "a streamed request must yield a stream");
      assert.equal(response.body, null, "a streamed request must not also be buffered");

      const timings = await readWithTimings(response.stream as ReadableStream<Uint8Array>);

      assert.ok(
        timings.firstAtMs < CHUNK_GAP_MS,
        `first chunk arrived after ${timings.firstAtMs}ms; a relay must not wait for the body`,
      );
      assert.ok(
        timings.lastAtMs >= CHUNK_GAP_MS * 2 * 0.8,
        "the provider really did take two gaps to finish, so the margin above is meaningful",
      );
      assert.ok(timings.text.includes("one") && timings.text.includes("[DONE]"));
    } finally {
      await close(provider);
    }
  });

  it("counts tokens from the terminal usage frame when the provider sends one", async () => {
    const provider = slowStreamingProvider({ withUsageFrame: true });
    const url = await listen(provider);
    const usage = collector();

    try {
      const call = createCaller({
        lists: {
          current: (): RankedList =>
            rankedList({ providers: [rankedProvider({ providerId: "stream", baseUrl: url })] }),
        },
        usage,
        fallback: rankedProvider({ baseUrl: url }),
        defaultWorkload: "default",
      });

      const response = await call({ model: "sim", messages: [], stream: true });
      await readWithTimings(response.stream as ReadableStream<Uint8Array>);

      assert.equal(usage.records.length, 1, "a stream is reported once, when it ends");
      assert.equal(usage.records[0]?.promptTokens, 11);
      assert.equal(usage.records[0]?.completionTokens, 22);
    } finally {
      await close(provider);
    }
  });

  it("falls back to a documented estimate when the provider sends no usage frame", async () => {
    const provider = slowStreamingProvider({ withUsageFrame: false });
    const url = await listen(provider);
    const usage = collector();

    try {
      const call = createCaller({
        lists: {
          current: (): RankedList =>
            rankedList({ providers: [rankedProvider({ providerId: "stream", baseUrl: url })] }),
        },
        usage,
        fallback: rankedProvider({ baseUrl: url }),
        defaultWorkload: "default",
      });

      const response = await call({ model: "sim", messages: [], stream: true });
      await readWithTimings(response.stream as ReadableStream<Uint8Array>);

      assert.equal(usage.records.length, 1);
      assert.ok(
        (usage.records[0]?.completionTokens ?? 0) > 0,
        "an estimate is still a count; reporting zero would silently under-bill",
      );
    } finally {
      await close(provider);
    }
  });
});
