import { createConnector } from "../index.js";
import { loadConnectorOptions } from "../config.js";

/**
 * One connector call, against whatever `CONNECTOR_FALLBACK_BASE_URL` and
 * `PROVIDER_API_KEY` point at, printed as a single JSON line.
 *
 * `sampleApp.ts` and `e2eApp.ts` both loop forever for a human or a log-scraping driver to
 * watch. `gateway/src/dev/realProviderCheck.ts` needs a program that makes exactly one call
 * through the real connector code path and then stops, so this exists rather than teaching
 * either of those two a bounded-count mode they have no other use for.
 */
async function main(): Promise<void> {
  const options = loadConnectorOptions(process.env);
  const connector = createConnector(options);
  const prompt = process.env["REAL_PROVIDER_PROMPT"] ?? "Reply with the single word: pong.";

  const startedAtMs = Date.now();
  try {
    const response = await connector.call({
      model: options.fallbackModel,
      messages: [{ role: "user", content: prompt }],
    });
    process.stdout.write(
      `${JSON.stringify({
        event: "call",
        providerId: response.providerId,
        status: response.status,
        ms: Date.now() - startedAtMs,
      })}\n`,
    );
    connector.close();
    process.exit(response.status >= 200 && response.status < 300 ? 0 : 1);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ event: "error", detail: String(error), ms: Date.now() - startedAtMs })}\n`,
    );
    connector.close();
    process.exit(1);
  }
}

void main();
