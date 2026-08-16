import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ServerResponse } from "node:http";

import { backoffDelayMs, createChannel, parseEventStream } from "../src/channel.js";
import type { RankedList } from "../src/types.js";
import { close, listen, rankedList, rankedProvider, readBody, serve } from "./helpers.js";

function frame(list: RankedList): string {
  return `event: list\ndata: ${JSON.stringify(list)}\n\n`;
}

function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const startedAtMs = Date.now();
  return new Promise((done, fail) => {
    const tick = (): void => {
      if (predicate()) return done();
      if (Date.now() - startedAtMs > timeoutMs) return fail(new Error("condition never held"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("the pushed channel", () => {
  it("parses each event, stores the list, and immediately acknowledges its version", async () => {
    const acks: { workload: string; version: number }[] = [];
    let streamRes: ServerResponse | null = null;

    const gateway = serve((req, res) => {
      if (req.url === "/v1/connector/stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": ping\n\n");
        res.write(
          frame(
            rankedList({
              version: 7,
              providers: [rankedProvider({ providerId: "sim-a", baseUrl: "http://a" })],
            }),
          ),
        );
        streamRes = res;
        return;
      }
      if (req.url === "/v1/connector/ack") {
        void readBody(req).then((body) => {
          acks.push(JSON.parse(body) as { workload: string; version: number });
          res.writeHead(204).end();
        });
        return;
      }
      res.writeHead(404).end();
    });

    const url = await listen(gateway);
    const channel = createChannel({ gatewayUrl: url, connectorToken: "t" });

    try {
      channel.start();
      await until(() => acks.length === 1);

      assert.deepEqual(acks[0], { workload: "default", version: 7 });
      assert.equal(channel.current("default")?.version, 7);
      assert.equal(channel.mode(), "push");
      assert.equal(channel.current("other"), null);
      assert.ok(streamRes !== null, "the gateway held the stream open rather than ending it");
    } finally {
      channel.close();
      await close(gateway);
    }
  });

  it("ignores heartbeats and unknown frames rather than mistaking them for directives", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller): void {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode(": ping\n\n"));
        controller.enqueue(encoder.encode("event: something-else\ndata: {}\n\n"));
        controller.enqueue(encoder.encode("event: list\ndata: not json\n\n"));
        // Split across chunk boundaries: the parser must reassemble, not drop.
        controller.enqueue(encoder.encode("event: list\ndata: {\"workload\":\"chat\","));
        controller.enqueue(encoder.encode('"version":3,"providers":[]}\n\n'));
        controller.close();
      },
    });

    const seen: RankedList[] = [];
    for await (const list of parseEventStream(body)) seen.push(list);

    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.workload, "chat");
    assert.equal(seen[0]?.version, 3);
  });
});

describe("reconnect backoff", () => {
  it("doubles from half a second and stops at thirty", () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5, 6].map((attempt) => backoffDelayMs(attempt)),
      [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000],
    );
    assert.equal(backoffDelayMs(50), 30_000, "growth is capped, never unbounded");
  });

  it("grows the delay across consecutive failed reconnects", async () => {
    const delays: number[] = [];
    // The gateway refuses the stream outright, so every pass through the loop is a failure
    // and the curve is visible without waiting out the real delays.
    const gateway = serve((req, res) => {
      if (req.url === "/v1/connector/lists") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ lists: [] }));
        return;
      }
      res.writeHead(503).end();
    });
    const url = await listen(gateway);

    const channel = createChannel({
      gatewayUrl: url,
      connectorToken: "t",
      onBackoff: (delayMs) => void delays.push(delayMs),
      sleep: (): Promise<void> => new Promise((done) => setTimeout(done, 1)),
    });

    try {
      channel.start();
      await until(() => delays.length >= 5);
      assert.deepEqual(delays.slice(0, 5), [500, 1_000, 2_000, 4_000, 8_000]);
    } finally {
      channel.close();
      await close(gateway);
    }
  });
});

describe("the polled degraded mode", () => {
  it("keeps receiving lists when the stream endpoint is unavailable", async () => {
    const acks: number[] = [];
    const gateway = serve((req, res) => {
      if (req.url === "/v1/connector/stream") {
        // The contract's `GATEWAY_SSE_DISABLED` shape: the stream is refused, not broken,
        // so the degraded mode is demonstrable without a firewall rule.
        res.writeHead(503).end();
        return;
      }
      if (req.url === "/v1/connector/lists") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ lists: [rankedList({ version: 4 })] }));
        return;
      }
      if (req.url === "/v1/connector/ack") {
        void readBody(req).then((body) => {
          acks.push((JSON.parse(body) as { version: number }).version);
          res.writeHead(204).end();
        });
        return;
      }
      res.writeHead(404).end();
    });
    const url = await listen(gateway);

    const channel = createChannel({
      gatewayUrl: url,
      connectorToken: "t",
      pollIntervalMs: 20,
      sleep: (): Promise<void> => new Promise((done) => setTimeout(done, 5)),
    });

    try {
      channel.start();
      await until(() => channel.current("default") !== null);

      assert.equal(channel.mode(), "poll", "polling must be distinguishable from a push");
      assert.equal(channel.current("default")?.version, 4);
      await until(() => acks.length >= 1);
      assert.equal(acks[0], 4, "a polled list is acknowledged too — later, which is the tell");
    } finally {
      channel.close();
      await close(gateway);
    }
  });

  it("never regresses to an older version when a poll races a push", async () => {
    const gateway = serve((req, res) => {
      if (req.url === "/v1/connector/stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(frame(rankedList({ version: 9 })));
        res.write(frame(rankedList({ version: 2 })));
        return;
      }
      res.writeHead(204).end();
    });
    const url = await listen(gateway);
    const channel = createChannel({ gatewayUrl: url, connectorToken: "t" });

    try {
      channel.start();
      await until(() => channel.current("default") !== null);
      // Both frames are already on the wire; give the stale one every chance to land.
      await new Promise((done) => setTimeout(done, 50));
      assert.equal(channel.current("default")?.version, 9);
    } finally {
      channel.close();
      await close(gateway);
    }
  });
});
