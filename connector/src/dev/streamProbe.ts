import { createCaller } from "../call.js";
import type { RankedList, RankedProvider } from "../types.js";

/**
 * Time-to-first-byte through the connector's streaming relay.
 *
 * The plan is explicit that this measurement is the only thing standing between a relay and
 * a buffer: "a buffering connector fails here and passes everything else". So the probe is
 * deliberately narrow — it issues one streamed request against a stub that emits chunks a
 * known interval apart and prints when the *first* byte arrived.
 *
 * It builds the caller directly rather than through `createConnector` because a connector
 * would open a control-plane channel and then route this request wherever the gateway's
 * ranked list points. What is under test is `call.ts`'s relay, and pinning the destination
 * is what makes the measured interval attributable to the relay rather than to routing.
 * The code path exercised is the real one: the same `createCaller`, the same `relayStream`.
 *
 *   PROBE_PROVIDER_URL      base URL of the streaming stub
 *   PROBE_CHUNK_INTERVAL_MS what the stub was configured to wait between chunks
 */
const PROVIDER_URL = process.env["PROBE_PROVIDER_URL"];
const CHUNK_INTERVAL_MS = Number(process.env["PROBE_CHUNK_INTERVAL_MS"] ?? 1000);

const provider: RankedProvider = {
  providerId: "stream-stub",
  baseUrl: (PROVIDER_URL ?? "").replace(/\/+$/, ""),
  model: "stream-stub",
  host: "stub",
  region: "local",
  reservationId: null,
  addressingModel: null,
};

async function main(): Promise<number> {
  if (PROVIDER_URL === undefined || PROVIDER_URL === "") {
    process.stdout.write(
      `${JSON.stringify({ event: "probe", ok: false, detail: "PROBE_PROVIDER_URL is required" })}\n`,
    );
    return 1;
  }

  const call = createCaller({
    lists: { current: (): RankedList | null => null },
    usage: { record: (): void => undefined },
    fallback: provider,
    defaultWorkload: "default",
  });

  const startedAtMs = Date.now();
  const response = await call({
    model: "stream-stub",
    stream: true,
    messages: [{ role: "user", content: "stream please" }],
    e2eApp: "stream-probe",
  });

  if (response.stream === null) {
    process.stdout.write(
      `${JSON.stringify({
        event: "probe",
        ok: false,
        detail: "connector returned no stream for a streamed request",
        status: response.status,
      })}\n`,
    );
    return 1;
  }

  let ttfbMs: number | null = null;
  let chunks = 0;
  let bytes = 0;
  const arrivalsMs: number[] = [];

  const reader = response.stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (ttfbMs === null) ttfbMs = Date.now() - startedAtMs;
    arrivalsMs.push(Date.now() - startedAtMs);
    chunks += 1;
    bytes += value.byteLength;
  }
  const totalMs = Date.now() - startedAtMs;

  process.stdout.write(
    `${JSON.stringify({
      event: "probe",
      ok: true,
      status: response.status,
      ttfbMs,
      totalMs,
      chunks,
      bytes,
      arrivalsMs,
      chunkIntervalMs: CHUNK_INTERVAL_MS,
    })}\n`,
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stdout.write(
      `${JSON.stringify({ event: "probe", ok: false, detail: String(error) })}\n`,
    );
    process.exitCode = 1;
  });
