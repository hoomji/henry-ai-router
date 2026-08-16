import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * The upstream stub the end-to-end verification observes.
 *
 * `stubUpstream.ts` is a canned answer and `simProvider.ts` adds latency and price, but the
 * M1 verification needs three things neither has, and all three are about *evidence* rather
 * than behavior:
 *
 * 1. A per-request log carrying a wall-clock instant and the identity of the caller. The
 *    architecture claim is "the sample application's traffic reached this provider and the
 *    gateway's log stayed empty", and the target-switch claim is "traffic moved within five
 *    seconds". Neither is checkable without timestamps on the provider's own side, and the
 *    switch claim is not checkable at all unless the stub can tell two sample applications
 *    apart, which it does by reading a marker field out of the request body.
 * 2. A streamed response with a controllable gap between chunks. A connector that buffers a
 *    stream passes every test that does not measure time-to-first-byte, so the stub has to
 *    be able to hold a stream open for a known interval.
 * 3. A forced status code with rate-limit headers, so the failover rule and the strain
 *    fields can be driven on demand rather than waited for.
 *
 * Dev-only, like everything else in this directory: nothing under `src/` outside `dev/`
 * imports it, and it holds no product behavior.
 */

/** Header naming which stub answered, so a split can be counted from responses alone. */
export const STUB_PROVIDER_HEADER = "x-sim-provider";
/** Header carrying the simulated unit rate, mirroring `simProvider.ts`. */
export const STUB_COST_HEADER = "x-sim-cost-per-1k-usd";

/** The body field the driver sets so the stub can attribute a call to a caller. */
export const APP_MARKER_FIELD = "e2eApp";

const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

export interface StubEntry {
  /** Wall clock at the moment the request was *received*, before any simulated latency. */
  readonly atMs: number;
  /** The `e2eApp` marker from the body, or `"unmarked"`. */
  readonly appId: string;
  readonly model: string;
  readonly stream: boolean;
  readonly status: number;
}

export interface StubProfile {
  readonly latencyMs: number;
  readonly costPer1kTokensUsd: number;
  /** When set, every request is answered with this status instead of a completion. */
  readonly forcedStatus: number | null;
  /** Rate-limit headers to attach, so a 429's strain fields are exercised. */
  readonly rateLimitHeaders: Readonly<Record<string, string>>;
  /** Gap between streamed chunks. One second is what the plan's TTFB check expects. */
  readonly streamChunkIntervalMs: number;
  readonly streamChunks: number;
}

export const DEFAULT_STUB_PROFILE: StubProfile = {
  latencyMs: 20,
  costPer1kTokensUsd: 0.01,
  forcedStatus: null,
  rateLimitHeaders: {},
  streamChunkIntervalMs: 1_000,
  streamChunks: 3,
};

export interface E2eStub {
  readonly name: string;
  readonly server: Server;
  /** Every request received, in arrival order. */
  readonly log: readonly StubEntry[];
  url(): string;
  listen(): Promise<string>;
  close(): Promise<void>;
  setProfile(next: Partial<StubProfile>): void;
  /** Requests received at or after `sinceMs`, optionally from one caller. */
  since(sinceMs: number, appId?: string): readonly StubEntry[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

function readBody(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
  });
}

interface ParsedRequest {
  readonly appId: string;
  readonly model: string;
  readonly stream: boolean;
}

function parseRequest(raw: string): ParsedRequest {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const appId = parsed[APP_MARKER_FIELD];
    return {
      appId: typeof appId === "string" ? appId : "unmarked",
      model: typeof parsed["model"] === "string" ? parsed["model"] : "unknown",
      stream: parsed["stream"] === true,
    };
  } catch {
    return { appId: "unmarked", model: "unknown", stream: false };
  }
}

function completionBody(name: string, promptTokens: number): string {
  return JSON.stringify({
    id: `chatcmpl-${name}`,
    object: "chat.completion",
    model: name,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: `stub response from ${name}` },
        finish_reason: "stop",
      },
    ],
    // Non-zero and non-round on purpose: the status resource's token counts must be
    // traceable back to a provider that reported them, not to a default.
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: 7,
      total_tokens: promptTokens + 7,
    },
  });
}

function mergeProfile(current: StubProfile, next: Partial<StubProfile>): StubProfile {
  return {
    latencyMs: next.latencyMs ?? current.latencyMs,
    costPer1kTokensUsd: next.costPer1kTokensUsd ?? current.costPer1kTokensUsd,
    forcedStatus: next.forcedStatus === undefined ? current.forcedStatus : next.forcedStatus,
    rateLimitHeaders: next.rateLimitHeaders ?? current.rateLimitHeaders,
    streamChunkIntervalMs: next.streamChunkIntervalMs ?? current.streamChunkIntervalMs,
    streamChunks: next.streamChunks ?? current.streamChunks,
  };
}

export function createE2eStub(options: {
  name: string;
  profile?: Partial<StubProfile>;
}): E2eStub {
  let profile = mergeProfile(DEFAULT_STUB_PROFILE, options.profile ?? {});
  const log: StubEntry[] = [];
  const name = options.name;

  const server = createServer((req, res) => {
    const url = (req.url ?? "").split("?")[0] ?? "";
    if (req.method !== "POST" || url !== CHAT_COMPLETIONS_PATH) {
      req.resume();
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `no such stub route: ${req.method ?? "?"} ${url}` }));
      return;
    }

    const receivedAtMs = Date.now();
    const active = profile;

    void (async (): Promise<void> => {
      const raw = await readBody(req);
      const parsed = parseRequest(raw);
      const status = active.forcedStatus ?? 200;

      log.push({
        atMs: receivedAtMs,
        appId: parsed.appId,
        model: parsed.model,
        stream: parsed.stream,
        status,
      });

      const headers: Record<string, string> = {
        [STUB_PROVIDER_HEADER]: name,
        [STUB_COST_HEADER]: String(active.costPer1kTokensUsd),
        ...active.rateLimitHeaders,
      };

      if (active.forcedStatus !== null) {
        await sleep(active.latencyMs);
        res.writeHead(active.forcedStatus, { ...headers, "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "forced by stub", type: "stub_error" } }));
        return;
      }

      if (parsed.stream) {
        // The whole point of this branch: the first chunk must be written and flushed long
        // before the last one, so a buffering relay is measurable rather than merely
        // suspected.
        res.writeHead(200, {
          ...headers,
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        for (let index = 0; index < active.streamChunks; index += 1) {
          await sleep(active.streamChunkIntervalMs);
          if (res.writableEnded) return;
          res.write(
            `data: ${JSON.stringify({
              id: `chatcmpl-${name}`,
              object: "chat.completion.chunk",
              model: name,
              choices: [{ index: 0, delta: { content: `chunk-${index}` } }],
            })}\n\n`,
          );
        }
        res.write(
          `data: ${JSON.stringify({
            id: `chatcmpl-${name}`,
            object: "chat.completion.chunk",
            model: name,
            choices: [],
            usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
          })}\n\n`,
        );
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      await sleep(active.latencyMs);
      // Prompt tokens scale with the body so the reported count cannot be a constant the
      // gateway could have invented for itself.
      res.writeHead(200, { ...headers, "content-type": "application/json" });
      res.end(completionBody(name, Math.max(1, Math.ceil(raw.length / 4))));
    })();
  });

  return {
    name,
    server,
    get log(): readonly StubEntry[] {
      return log;
    },
    url(): string {
      const address = server.address() as AddressInfo | null;
      if (address === null) throw new Error(`stub ${name} is not listening`);
      return `http://127.0.0.1:${address.port}`;
    },
    listen(): Promise<string> {
      return new Promise((done) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address() as AddressInfo;
          done(`http://127.0.0.1:${address.port}`);
        });
      });
    },
    close(): Promise<void> {
      return new Promise((done) => {
        server.closeAllConnections?.();
        server.close(() => done());
      });
    },
    setProfile(next: Partial<StubProfile>): void {
      profile = mergeProfile(profile, next);
    },
    since(sinceMs: number, appId?: string): readonly StubEntry[] {
      return log.filter(
        (entry) => entry.atMs >= sinceMs && (appId === undefined || entry.appId === appId),
      );
    },
  };
}
