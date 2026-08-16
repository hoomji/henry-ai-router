import { createConnector } from "../index.js";
import { loadConnectorOptions } from "../config.js";

/**
 * The sample application, instrumented.
 *
 * `sampleApp.ts` is the human-readable demonstration: a person watches its lines move from
 * one provider to another. This is the same loop written for a verifier instead of a
 * reader — one JSON object per line, and a marker in the request body so the stub upstream
 * can attribute a call to *this* driver rather than to a second one running beside it.
 *
 * That marker is what makes the target-switch check honest. Two drivers on two workloads
 * are needed for the architecture observation (both upstreams must show traffic), and once
 * two drivers exist, "traffic moved to the cheap stub" is only evidence if the cheap stub
 * can say whose traffic it was.
 *
 * Configured entirely from the environment, like the connector itself:
 *   E2E_APP_ID          the marker written into each request body
 *   E2E_INTERVAL_MS     delay between calls (default 250)
 *   plus the connector's own GATEWAY_URL / GATEWAY_CONNECTOR_TOKEN / CONNECTOR_* variables.
 */
const APP_ID = process.env["E2E_APP_ID"] ?? "app";
const INTERVAL_MS = Number(process.env["E2E_INTERVAL_MS"] ?? 250);

function emit(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ app: APP_ID, ...record })}\n`);
}

async function main(): Promise<void> {
  const options = loadConnectorOptions(process.env);
  const connector = createConnector(options);

  const stop = (): void => {
    connector.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  emit({ event: "start", workload: options.workload, atMs: Date.now() });

  for (let n = 1; ; n += 1) {
    const startedAtMs = Date.now();
    try {
      const response = await connector.call({
        model: options.fallbackModel,
        messages: [{ role: "user", content: `e2e request ${n}` }],
        // The stub reads this field back out to attribute the call. It rides in the body
        // because the connector's request path passes the body through untouched and adds
        // no caller-controlled headers — inventing one for a test would change the surface
        // being verified.
        e2eApp: APP_ID,
      });
      emit({
        event: "call",
        n,
        atMs: startedAtMs,
        providerId: response.providerId,
        status: response.status,
        mode: connector.mode(),
        listVersion: connector.currentList()?.version ?? null,
        unmet: response.headers["x-gateway-target-unmet"] ?? null,
        ms: Date.now() - startedAtMs,
      });
    } catch (error) {
      emit({ event: "error", n, atMs: startedAtMs, detail: String(error) });
    }
    await new Promise((done) => setTimeout(done, INTERVAL_MS));
  }
}

void main();
