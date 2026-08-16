import { createServer } from "node:http";
import type { IncomingMessage, RequestListener, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { RankedList, RankedProvider, UsageRecord } from "../src/types.js";

/** Every test server binds port 0 so the suite is port-safe and can run in parallel with
 * a developer's own gateway already listening. */
export function listen(server: Server): Promise<string> {
  return new Promise((resolveListening) => {
    server.listen(0, "127.0.0.1", () => {
      resolveListening(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

export function close(server: Server): Promise<void> {
  return new Promise((resolveClosed) => {
    server.closeAllConnections();
    server.close(() => resolveClosed());
  });
}

export function serve(handler: RequestListener): Server {
  return createServer(handler);
}

export function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
  });
}

/** A provider that answers one canned status, recording how many calls it saw. */
export function stubProvider(options: {
  name: string;
  status?: number;
  headers?: Record<string, string>;
}): Server & { calls(): number; bodies(): readonly string[] } {
  let calls = 0;
  const bodies: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void readBody(req).then((body) => {
      calls += 1;
      bodies.push(body);
      const status = options.status ?? 200;
      res.writeHead(status, { "content-type": "application/json", ...(options.headers ?? {}) });
      res.end(
        JSON.stringify({
          model: options.name,
          choices: [{ message: { role: "assistant", content: options.name } }],
          usage: { prompt_tokens: 3, completion_tokens: 7 },
        }),
      );
    });
  });
  return Object.assign(server, {
    calls: (): number => calls,
    bodies: (): readonly string[] => bodies,
  });
}

export function rankedProvider(overrides: Partial<RankedProvider> & { baseUrl: string }): RankedProvider {
  return {
    providerId: overrides.providerId ?? "sim",
    baseUrl: overrides.baseUrl,
    model: overrides.model ?? "sim",
    host: overrides.host ?? "sim",
    region: overrides.region ?? "local",
    reservationId: overrides.reservationId ?? null,
    addressingModel: overrides.addressingModel ?? null,
  };
}

export function rankedList(overrides: Partial<RankedList>): RankedList {
  return {
    workload: overrides.workload ?? "default",
    version: overrides.version ?? 1,
    providers: overrides.providers ?? [],
    unmetDimension: overrides.unmetDimension ?? null,
    boundBy: overrides.boundBy ?? null,
    computedAtMs: overrides.computedAtMs ?? 0,
  };
}

export function usageRecord(overrides: Partial<UsageRecord>): UsageRecord {
  return {
    workload: overrides.workload ?? "default",
    providerId: overrides.providerId ?? "sim",
    model: overrides.model ?? "sim",
    region: overrides.region ?? "local",
    promptTokens: overrides.promptTokens ?? 1,
    completionTokens: overrides.completionTokens ?? 1,
    latencyMs: overrides.latencyMs ?? 1,
    statusCode: overrides.statusCode ?? 200,
    rateLimitLimit: overrides.rateLimitLimit ?? null,
    rateLimitReset: overrides.rateLimitReset ?? null,
    reservationId: overrides.reservationId ?? null,
    atMs: overrides.atMs ?? 0,
  };
}

/** Collects usage records in memory, standing in for the reporter in request-path tests. */
export function collector(): { record(r: UsageRecord): void; records: UsageRecord[] } {
  const records: UsageRecord[] = [];
  return { record: (r: UsageRecord): void => void records.push(r), records };
}
