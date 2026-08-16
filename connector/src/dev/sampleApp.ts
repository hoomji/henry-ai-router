import { createConnector } from "../index.js";
import { loadConnectorOptions } from "../config.js";

/**
 * A stand-in for the customer's application.
 *
 * Its only job is to make the architecture observable: it calls providers through the
 * connector in a loop and prints which provider answered each call, so a person can watch
 * the traffic split move when a target changes — while the gateway's own access log shows
 * no chat completions at all. That single side-by-side observation is the whole product
 * boundary, and it needs a program that does nothing else.
 */
const INTERVAL_MS = Number(process.env["SAMPLE_INTERVAL_MS"] ?? 500);

async function main(): Promise<void> {
  const options = loadConnectorOptions(process.env);
  const connector = createConnector(options);

  const stop = (): void => {
    connector.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  process.stdout.write(
    `sample app calling through the connector for workload "${options.workload}"\n`,
  );

  for (let n = 1; ; n += 1) {
    const startedAtMs = Date.now();
    try {
      const response = await connector.call({
        model: options.fallbackModel,
        messages: [{ role: "user", content: `sample request ${n}` }],
      });
      const unmet = response.headers["x-gateway-target-unmet"] ?? "-";
      process.stdout.write(
        `#${n} provider=${response.providerId} status=${response.status} ` +
          `mode=${connector.mode()} unmet=${unmet} ms=${Date.now() - startedAtMs}\n`,
      );
    } catch (error) {
      // Printed rather than thrown: a connector that cannot reach any provider is a
      // finding to watch in the log, not a reason for the loop to end mid-demonstration.
      process.stdout.write(`#${n} failed: ${String(error)}\n`);
    }
    await new Promise((done) => setTimeout(done, INTERVAL_MS));
  }
}

void main();
