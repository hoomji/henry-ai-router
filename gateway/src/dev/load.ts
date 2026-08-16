import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { loadConfig } from "../config.js";
import { createGateway } from "../server.js";
import { createSimProvider, SIM_COST_HEADER, SIM_PROVIDER_HEADER } from "./simProvider.js";
import type { SimProviderServer } from "./simProvider.js";

/**
 * The milestone's evidence: the same traffic, the same providers, no routing rule
 * anywhere — and a request split that changes because the *target* changed.
 *
 * Everything runs in this one process on ephemeral ports so the run is reproducible on a
 * laptop with no credentials, no ports to reserve, and no state left behind. The output is
 * meant to be pasted into an ExecPlan, which is why it prints the window settings it used:
 * a reader must not mistake this three-second demo window for the production one.
 *
 * The script exits non-zero when the two splits come out identical. Evidence that cannot
 * fail is not evidence.
 */

// ---------------------------------------------------------------------------
// Scenario constants
// ---------------------------------------------------------------------------

/** Fixed by the capability catalogue: these exact model@host names are what targets name. */
const FAST = { id: "sim-a", model: "sim-fast", host: "sim-a" } as const;
const CHEAP = { id: "sim-b", model: "sim-cheap", host: "sim-b" } as const;

const FAST_PROFILE = { latencyMs: 120, jitterMs: 40, costPer1kTokensUsd: 0.03, errorRate: 0 };
const CHEAP_PROFILE = { latencyMs: 700, jitterMs: 120, costPer1kTokensUsd: 0.002, errorRate: 0 };

/** The workload named by `x-gateway-workload`, alongside `default`, in the same run. */
const SECOND_WORKLOAD = "batch";

/**
 * Large enough that a handful of exploration picks cannot swing the percentage.
 *
 * The warmup is *not* a fixed count: see `warmUntilMeasured`. Measuring a fixed warmup
 * meant measuring the exploration transient, and which provider that favored was luck.
 */
const MEASURED_REQUESTS = 200;
const WARMUP_BATCH = 16;
const CONCURRENCY = 8;
const WARMUP_DEADLINE_MS = 30_000;

/** Demo window shape. Production defaults are 300s / 200 requests / floor 20. */
const WINDOW = { windowMs: "1000", windowMinRequests: "8", sampleFloor: "5", pollMs: "250" };

/**
 * Requests one provider needs before a window of its own can close.
 *
 * A window closes only after `GATEWAY_WINDOW_MIN_REQUESTS` requests have gone to *that*
 * provider, and until one closes the provider stays `insufficient_data` — which routing
 * deliberately prefers, because a provider that is never chosen can never be measured.
 * The margin covers the requests that land in a window already in flight.
 */
const MEASURED_THRESHOLD = Number(WINDOW.windowMinRequests) + 2;

/**
 * How long to keep trying for a populated status reading before giving up.
 *
 * The status resource has a *narrow* visibility window in both directions, and getting
 * either side wrong prints `insufficient_data` for a workload that just served sixty
 * requests. A window's summary is not written until the window closes on the service's
 * timer, so reading the instant the last request returns is too early; but
 * `readWindowSummaries` looks back exactly one window, so a summary also ages out of view
 * one window after that — waiting a fixed settle time is too late. Polling is the only
 * reading that is right at both ends.
 */
const STATUS_DEADLINE_MS = 8_000;
const STATUS_POLL_MS = 200;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function listen(server: Server): Promise<string> {
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      done(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((done) => {
    server.closeAllConnections?.();
    server.close(() => done());
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

function percentile(sorted: readonly number[], share: number): number | null {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1);
  return sorted[index] ?? null;
}

function pad(value: string, width: number): string {
  return value.padEnd(width);
}

function padLeft(value: string, width: number): string {
  return value.padStart(width);
}

function heading(text: string): void {
  console.log("");
  console.log(text);
  console.log("-".repeat(Math.max(text.length, 60)));
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

interface Sample {
  readonly providerId: string;
  readonly latencyMs: number;
  readonly costPer1kTokensUsd: number;
  readonly ok: boolean;
}

interface Split {
  /** Provider id -> request count. */
  readonly counts: Readonly<Record<string, number>>;
  readonly p95ByProvider: Readonly<Record<string, number | null>>;
  readonly blendedCostPer1kUsd: number | null;
  readonly total: number;
  readonly failures: number;
}

const REQUEST_BODY = JSON.stringify({
  model: "sim",
  messages: [{ role: "user", content: "load" }],
});

/**
 * Attribute one response to a provider.
 *
 * The gateway's own header is preferred when present — it is the gateway's account of its
 * own decision. The sim header is the fallback, and it is the stronger evidence of the
 * two: it comes from the process that actually served the call, so a split counted from it
 * cannot be an artifact of the gateway reporting a choice it did not make.
 */
function attribute(headers: Headers): string {
  return (
    headers.get("x-gateway-provider") ?? headers.get(SIM_PROVIDER_HEADER) ?? "unattributed"
  );
}

async function oneRequest(gatewayUrl: string, workload: string): Promise<Sample> {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-workload": workload },
      body: REQUEST_BODY,
    });
    await response.text();
    const cost = Number(response.headers.get(SIM_COST_HEADER) ?? "0");
    return {
      providerId: attribute(response.headers),
      latencyMs: Date.now() - startedAt,
      costPer1kTokensUsd: Number.isFinite(cost) ? cost : 0,
      ok: response.status < 400,
    };
  } catch {
    return {
      providerId: "unreachable",
      latencyMs: Date.now() - startedAt,
      costPer1kTokensUsd: 0,
      ok: false,
    };
  }
}

/** Drive `count` requests at fixed concurrency, collecting every sample. */
async function drive(gatewayUrl: string, workload: string, count: number): Promise<Sample[]> {
  const samples: Sample[] = [];
  let issued = 0;

  const worker = async (): Promise<void> => {
    while (issued < count) {
      issued += 1;
      samples.push(await oneRequest(gatewayUrl, workload));
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return samples;
}

/**
 * Warm up until both providers are measured, rather than for a fixed count.
 *
 * This is the whole difference between measuring steady-state routing and measuring the
 * exploration transient. Routing prefers a candidate whose objective dimension is
 * `insufficient_data`, so until *both* providers have closed a window the split is a
 * report on exploration, not on the target — and a fixed warmup left that to chance.
 *
 * The gate is per-provider request counts rather than the status resource: `status` reports
 * `bestObserved` across the merged providers and exposes no per-provider breakdown, so it
 * cannot answer "is sim-b measured yet". Counting the requests that a provider actually
 * served answers it directly, since a closed window is exactly what those requests buy.
 */
async function warmUntilMeasured(
  gatewayUrl: string,
  workload: string,
): Promise<{ requests: number; counts: Record<string, number>; measured: boolean }> {
  const counts: Record<string, number> = { [FAST.id]: 0, [CHEAP.id]: 0 };
  let requests = 0;
  const startedAt = Date.now();

  while (Date.now() - startedAt < WARMUP_DEADLINE_MS) {
    for (const sample of await drive(gatewayUrl, workload, WARMUP_BATCH)) {
      counts[sample.providerId] = (counts[sample.providerId] ?? 0) + 1;
      requests += 1;
    }

    const measured = [FAST.id, CHEAP.id].every(
      (id) => (counts[id] ?? 0) >= MEASURED_THRESHOLD,
    );
    if (!measured) continue;

    // Both have enough traffic behind them; give their windows time to close and be
    // published before the measured phase starts reading the result.
    await sleep(Number(WINDOW.windowMs) + 2 * Number(WINDOW.pollMs));
    return { requests, counts, measured: true };
  }

  return { requests, counts, measured: false };
}

function summarize(samples: readonly Sample[]): Split {
  const counts: Record<string, number> = {};
  const latencies: Record<string, number[]> = {};
  let costSum = 0;
  let failures = 0;

  for (const sample of samples) {
    counts[sample.providerId] = (counts[sample.providerId] ?? 0) + 1;
    (latencies[sample.providerId] ??= []).push(sample.latencyMs);
    costSum += sample.costPer1kTokensUsd;
    if (!sample.ok) failures += 1;
  }

  const p95ByProvider: Record<string, number | null> = {};
  for (const providerId of Object.keys(latencies)) {
    const values = [...(latencies[providerId] ?? [])].sort((a, b) => a - b);
    p95ByProvider[providerId] = percentile(values, 0.95);
  }

  return {
    counts,
    p95ByProvider,
    blendedCostPer1kUsd: samples.length === 0 ? null : costSum / samples.length,
    total: samples.length,
    failures,
  };
}

function printSplit(label: string, split: Split): void {
  console.log(
    `${pad("provider", 12)}${padLeft("requests", 10)}${padLeft("share", 9)}${padLeft("p95 ms", 10)}`,
  );
  // Every configured provider gets a row, including one that received nothing. A zero row
  // says "this provider lost"; an absent row is indistinguishable from "this provider was
  // never a candidate", and those are very different facts about a routing decision.
  const rows = [FAST.id, CHEAP.id, "unattributed", "unreachable"];
  for (const providerId of rows) {
    const count = split.counts[providerId] ?? 0;
    const configured = providerId === FAST.id || providerId === CHEAP.id;
    if (count === 0 && !configured) continue;
    const share = split.total === 0 ? 0 : (count / split.total) * 100;
    const p95 = split.p95ByProvider[providerId];
    console.log(
      pad(providerId, 12) +
        padLeft(String(count), 10) +
        padLeft(`${share.toFixed(1)}%`, 9) +
        padLeft(p95 === null || p95 === undefined ? "n/a" : String(p95), 10),
    );
  }
  const blended = split.blendedCostPer1kUsd;
  console.log(
    `${pad(label, 12)}${padLeft(String(split.total), 10)} total, ` +
      `${split.failures} failed, blended cost/1k $` +
      (blended === null ? "n/a" : blended.toFixed(5)),
  );
}

/** The one number the comparison turns on: share of traffic sent to the fast provider. */
function fastShare(split: Split): number {
  if (split.total === 0) return 0;
  return (split.counts[FAST.id] ?? 0) / split.total;
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

const ALLOWED = [`${FAST.model}@${FAST.host}`, `${CHEAP.model}@${CHEAP.host}`];

/**
 * Run A targets latency, Run B targets cost. Same allowed models, same providers, same
 * traffic — the only difference between the two documents is what the customer asked for.
 */
function documentFor(run: "A" | "B"): Record<string, unknown> {
  const latencyWorkload = {
    allowed_models: ALLOWED,
    p95_ms: 400,
    objective: "p95_ms",
  };
  const costWorkload = {
    allowed_models: ALLOWED,
    cost_per_1k_tokens_usd: 0.05,
    objective: "cost_per_1k_tokens_usd",
  };

  return {
    workloads: {
      // `default` carries the run's target; the second workload always carries the other
      // one, so a single run also shows two workloads diverging under one gateway.
      default: run === "A" ? latencyWorkload : costWorkload,
      [SECOND_WORKLOAD]: run === "A" ? costWorkload : latencyWorkload,
    },
  };
}

async function putTargets(gatewayUrl: string, run: "A" | "B"): Promise<void> {
  const current = await fetch(`${gatewayUrl}/v1/targets`);
  let version = 0;
  if (current.ok) {
    const body: unknown = await current.json();
    if (typeof body === "object" && body !== null) {
      const stated = (body as Record<string, unknown>)["version"];
      if (typeof stated === "number") version = stated;
    }
  } else {
    await current.text();
  }

  const document = { version, ...documentFor(run) };
  const response = await fetch(`${gatewayUrl}/v1/targets`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(document),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`PUT /v1/targets failed with ${response.status}: ${text}`);
  }
}

/** True once at least one dimension reports a window with requests behind it. */
function statusIsPopulated(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const dimensions = (parsed as Record<string, unknown>)["dimensions"];
  if (!Array.isArray(dimensions)) return false;
  return dimensions.some((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const count = (entry as Record<string, unknown>)["windowRequestCount"];
    return typeof count === "number" && count > 0;
  });
}

/**
 * Read the status resource, retrying until it has a closed window behind it.
 *
 * A trickle request goes out on each attempt: windows close on the service timer, but a
 * closed window that nothing has refreshed since ages out of the one-window lookback, so
 * a completely idle gateway settles into an empty status. One request per attempt is
 * enough to keep a window open and is far below the measured phases, so it cannot move
 * the split that was already counted.
 */
async function printStatus(gatewayUrl: string, workload: string): Promise<void> {
  const startedAt = Date.now();
  let status = 0;
  let text = "";

  while (Date.now() - startedAt < STATUS_DEADLINE_MS) {
    await oneRequest(gatewayUrl, workload);
    await sleep(STATUS_POLL_MS);
    const response = await fetch(`${gatewayUrl}/v1/workloads/${workload}/status`);
    status = response.status;
    text = await response.text();
    if (response.ok && statusIsPopulated(text)) break;
  }

  const waitedMs = Date.now() - startedAt;
  console.log(`GET /v1/workloads/${workload}/status -> ${status} (after ${waitedMs}ms)`);
  console.log(text);
  if (!statusIsPopulated(text)) {
    console.log(
      `  NOTE: no closed window was visible within ${STATUS_DEADLINE_MS}ms. The split above ` +
        `is still measured traffic; only this resource is empty.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

interface RunResult {
  readonly defaultSplit: Split;
  readonly secondSplit: Split;
}

/**
 * Warm, measure, and report one workload.
 *
 * Workloads are done one at a time rather than warmed together, because a summary is only
 * visible for one window after it closes: warming both up front would let the first
 * workload's measurements age out again before its own measured phase began, putting it
 * straight back into exploration.
 */
async function measureWorkload(gatewayUrl: string, workload: string): Promise<Split> {
  const warm = await warmUntilMeasured(gatewayUrl, workload);

  const perProvider = [FAST.id, CHEAP.id]
    .map((id) => `${id}=${warm.counts[id] ?? 0}`)
    .join(", ");
  console.log(
    `warmup for "${workload}": ${warm.requests} requests until both providers were ` +
      `measured (${perProvider}; a window closes at ${WINDOW.windowMinRequests} requests ` +
      `to a provider). That count is the honest cost of exploration.`,
  );

  if (!warm.measured) {
    console.log(
      `  WARNING: one provider never reached ${MEASURED_THRESHOLD} requests within ` +
        `${WARMUP_DEADLINE_MS}ms. The split below still contains exploration traffic and ` +
        `is not a steady-state reading.`,
    );
  }

  const split = summarize(await drive(gatewayUrl, workload, MEASURED_REQUESTS));
  printSplit(workload, split);
  return split;
}

async function runOnce(gatewayUrl: string, run: "A" | "B", target: string): Promise<RunResult> {
  await putTargets(gatewayUrl, run);

  heading(`RUN ${run} — workload "default" targets ${target}`);
  const defaultSplit = await measureWorkload(gatewayUrl, "default");
  console.log("");
  console.log(
    `polling for a closed window (window ${WINDOW.windowMs}ms, poll ${WINDOW.pollMs}ms) ...`,
  );
  await printStatus(gatewayUrl, "default");

  console.log("");
  console.log(
    `workload "${SECOND_WORKLOAD}" (x-gateway-workload), same run, the OTHER target:`,
  );
  const secondSplit = await measureWorkload(gatewayUrl, SECOND_WORKLOAD);
  console.log("");
  await printStatus(gatewayUrl, SECOND_WORKLOAD);

  return { defaultSplit, secondSplit };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const storeDir = mkdtempSync(join(tmpdir(), "gateway-load-"));
  const storePath = join(storeDir, "store.sqlite");

  const sims: SimProviderServer[] = [];
  let gateway: Server | null = null;

  try {
    const fastSim = createSimProvider({ name: FAST.id, profile: FAST_PROFILE });
    const cheapSim = createSimProvider({ name: CHEAP.id, profile: CHEAP_PROFILE });
    sims.push(fastSim, cheapSim);

    const fastUrl = await listen(fastSim);
    const cheapUrl = await listen(cheapSim);

    const providers = [
      { id: FAST.id, baseUrl: fastUrl, model: FAST.model, host: FAST.host },
      { id: CHEAP.id, baseUrl: cheapUrl, model: CHEAP.model, host: CHEAP.host },
    ];

    // Built as a record and handed to `loadConfig`, rather than mutating `process.env`:
    // the config surface takes an env-like argument precisely so a harness does not have
    // to reach into global state to exercise it.
    const env: NodeJS.ProcessEnv = {
      UPSTREAM_BASE_URL: fastUrl,
      // Parsed but unused: this harness listens on an ephemeral port itself, so nothing
      // here can collide with a gateway the reader already has running.
      PORT: "8080",
      GATEWAY_PROVIDERS: JSON.stringify(providers),
      GATEWAY_STORE_PATH: storePath,
      GATEWAY_WINDOW_MS: WINDOW.windowMs,
      GATEWAY_WINDOW_MIN_REQUESTS: WINDOW.windowMinRequests,
      GATEWAY_SAMPLE_FLOOR: WINDOW.sampleFloor,
      GATEWAY_POLL_MS: WINDOW.pollMs,
      GATEWAY_NOTIFY_SECRET: "sim-load-secret",
    };

    const config = loadConfig(env);
    gateway = createGateway(config);
    const gatewayUrl = await listen(gateway);

    heading("SETUP");
    console.log(`${pad("reproduce with", 22)}npm --prefix gateway run load`);
    console.log(`${pad("gateway", 22)}${gatewayUrl}`);
    console.log(
      `${pad(`${FAST.model}@${FAST.host}`, 22)}${pad(fastUrl, 26)}` +
        `${FAST_PROFILE.latencyMs}ms +/-${FAST_PROFILE.jitterMs}, $${FAST_PROFILE.costPer1kTokensUsd}/1k`,
    );
    console.log(
      `${pad(`${CHEAP.model}@${CHEAP.host}`, 22)}${pad(cheapUrl, 26)}` +
        `${CHEAP_PROFILE.latencyMs}ms +/-${CHEAP_PROFILE.jitterMs}, $${CHEAP_PROFILE.costPer1kTokensUsd}/1k`,
    );
    console.log(`${pad("store", 22)}${storePath}`);
    console.log("");
    console.log("DEMO window settings — NOT production defaults (300000ms / 200 req / floor 20):");
    console.log(
      `${pad("GATEWAY_WINDOW_MS", 30)}${WINDOW.windowMs}\n` +
        `${pad("GATEWAY_WINDOW_MIN_REQUESTS", 30)}${WINDOW.windowMinRequests}\n` +
        `${pad("GATEWAY_SAMPLE_FLOOR", 30)}${WINDOW.sampleFloor}\n` +
        `${pad("GATEWAY_POLL_MS", 30)}${WINDOW.pollMs}`,
    );
    console.log(
      `${pad("requests per phase", 30)}warm until both measured, then ${MEASURED_REQUESTS} ` +
        `measured, concurrency ${CONCURRENCY}`,
    );
    console.log("");
    console.log("No routing rule is configured anywhere. Only the target differs between runs.");
    console.log(
      "Splits are taken from the measured phase only, after both providers have closed a\n" +
        "window. Expect a small residual share on the non-preferred provider even so: the\n" +
        "gateway keeps sending it a little traffic to check whether its own measurements are\n" +
        "still true. A 90/10 split is that mechanism working, not a routing bug.",
    );

    const runA = await runOnce(gatewayUrl, "A", "p95_ms (latency)");
    const runB = await runOnce(gatewayUrl, "B", "cost_per_1k_tokens_usd (cost)");

    const shareA = fastShare(runA.defaultSplit);
    const shareB = fastShare(runB.defaultSplit);

    heading("THE CLAIM — same providers, same traffic, different target");
    console.log(
      `${pad("run", 8)}${pad("default target", 30)}${padLeft(`${FAST.id} share`, 14)}` +
        `${padLeft(`${CHEAP.id} share`, 14)}${padLeft("blended $/1k", 15)}`,
    );
    for (const [run, target, split] of [
      ["A", "p95_ms", runA.defaultSplit],
      ["B", "cost_per_1k_tokens_usd", runB.defaultSplit],
    ] as const) {
      const fast = fastShare(split);
      const blended = split.blendedCostPer1kUsd;
      console.log(
        pad(run, 8) +
          pad(target, 30) +
          padLeft(`${(fast * 100).toFixed(1)}%`, 14) +
          padLeft(`${((1 - fast) * 100).toFixed(1)}%`, 14) +
          padLeft(blended === null ? "n/a" : `$${blended.toFixed(5)}`, 15),
      );
    }
    console.log("");
    // The cost delta is the other half of the claim: a split that moved without moving
    // the bill would not be worth a customer's attention.
    const costA = runA.defaultSplit.blendedCostPer1kUsd;
    const costB = runB.defaultSplit.blendedCostPer1kUsd;
    if (costA !== null && costB !== null) {
      console.log(
        `blended cost per 1k tokens: run A $${costA.toFixed(5)} -> run B $${costB.toFixed(5)} ` +
          `(${costA === 0 ? "n/a" : `${(((costB - costA) / costA) * 100).toFixed(1)}%`})`,
      );
    }
    console.log(
      `shift in ${FAST.id}'s share between the runs: ` +
        `${((shareA - shareB) * 100).toFixed(1)} percentage points`,
    );

    if (runA.defaultSplit.total === 0 || runB.defaultSplit.total === 0) {
      console.log("");
      console.log("FAIL: no requests completed; there is nothing to conclude.");
      return 1;
    }

    if (shareA === shareB) {
      console.log("");
      console.log(
        "FAIL: the split is identical under both targets. The target is not changing the " +
          "routing decision, so this run is not evidence for the milestone's claim.",
      );
      return 1;
    }

    // Direction is the claim. "The numbers differ" would pass on noise, and a run that
    // passes on noise is what put this check under suspicion in the first place.
    if (shareA <= 0.5) {
      console.log("");
      console.log(
        `FAIL: under a latency target the fast provider (${FAST.id}) holds only ` +
          `${(shareA * 100).toFixed(1)}% of the traffic. The faster provider must hold the ` +
          `larger share when latency is what was asked for.`,
      );
      return 1;
    }

    if (shareA < shareB) {
      console.log("");
      console.log(
        "FAIL: the latency target sent LESS traffic to the fast provider than the cost " +
          "target did. The split moved, but in the wrong direction.",
      );
      return 1;
    }

    if (costA === null || costB === null || costA <= costB) {
      console.log("");
      console.log(
        "FAIL: the cost target did not come out cheaper than the latency target. Buying " +
          "latency is supposed to cost more; if it does not, the split moved without " +
          "moving the bill and there is nothing here a customer would pay for.",
      );
      return 1;
    }

    console.log("");
    console.log(
      "PASS: under the latency target the fast provider holds the larger share and the " +
        "blended cost is higher; under the cost target both move the other way.",
    );
    return 0;
  } finally {
    if (gateway !== null) await close(gateway);
    for (const sim of sims) await close(sim);
    // A temp store per run: no run inherits another's windows or `unmet` state.
    rmSync(storeDir, { recursive: true, force: true });
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("[load] failed:", error);
    process.exitCode = 1;
  });
