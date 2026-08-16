import { spawn } from "node:child_process";
import type { ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createE2eStub } from "./e2eStub.js";
import type { E2eStub } from "./e2eStub.js";

/**
 * The end-to-end verification for M1: the gateway out of the request path.
 *
 * Everything in `docs/exec-plans/completed/2026-08-15-connector-and-reservation-aware-routing.md`
 * under M1's *Verification* is driven here against real processes — two stub upstreams in
 * this process, the gateway as a child process (so it can be killed), and the sample
 * application as child processes (so it can be watched surviving that). Each check prints
 * the evidence it asserted on, and the script exits non-zero if any of them fails.
 *
 * Two deliberate design choices, both about whether the evidence discriminates:
 *
 * The gateway is a *separate process with an access log* rather than an in-process server.
 * The central claim is a negative one — no chat completion reached the gateway — and a
 * negative is only worth anything if the observer would have seen a positive. So the gateway
 * logs every request it receives, and the check reports the requests it *did* see alongside
 * the absence of the ones it must not have.
 *
 * The reconnect backoff is measured by putting a *listener* on the gateway's port after
 * killing the gateway. A closed port proves the connector survives, but it cannot show the
 * shape of the retry curve, and "backs off rather than spins" is a claim about that shape.
 */

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

const FAST = { id: "sim-a", model: "sim-fast", host: "sim-a" } as const;
const CHEAP = { id: "sim-b", model: "sim-cheap", host: "sim-b" } as const;

const ALLOWED_BOTH = [`${FAST.model}@${FAST.host}`, `${CHEAP.model}@${CHEAP.host}`];
const ALLOWED_CHEAP_ONLY = [`${CHEAP.model}@${CHEAP.host}`];

const DEFAULT_APP = "default-app";
const BATCH_APP = "batch-app";

/** How long the architecture observation runs. The plan says "a minute". */
const OBSERVE_MS = Number(process.env["E2E_OBSERVE_MS"] ?? 60_000);
/** The five-second allowance the specification states for a target change. */
const SWITCH_BUDGET_MS = 5_000;
/** How long the streaming stub waits between chunks. */
const STREAM_CHUNK_INTERVAL_MS = 1_000;

/** Demo window shape. Production defaults are 300000ms / 200 requests / floor 20. */
const WINDOW = {
  GATEWAY_WINDOW_MS: "1000",
  GATEWAY_WINDOW_MIN_REQUESTS: "8",
  GATEWAY_SAMPLE_FLOOR: "5",
  GATEWAY_POLL_MS: "250",
  GATEWAY_PUSH_DEBOUNCE_MS: "500",
} as const;

const ADMIN_TOKEN = "e2e-admin-token";
/**
 * The customer the connectors authenticate as.
 *
 * `"default"` rather than a realistic name, and that is a *finding* rather than a
 * convenience: `TargetService` opens its store at `DEFAULT_CUSTOMER_ID` and the management
 * surface has no way to name a customer, so a connector minted under any other id writes
 * usage and directive rows the status resource can never read. Check 3b demonstrates that
 * directly; the rest of the run uses `"default"` so the other checks measure what they
 * claim to measure rather than all failing for this one reason.
 */
const CUSTOMER_ID = "default";
/** A second customer, used only to demonstrate the scoping gap in check 3b. */
const OTHER_CUSTOMER_ID = "acme";

const HERE = dirname(fileURLToPath(import.meta.url));
/** `dist/src/dev` -> repository root. */
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const GATEWAY_ENTRY = resolve(HERE, "loggedGateway.js");
const CONNECTOR_APP = join(REPO_ROOT, "connector", "dist", "src", "dev", "e2eApp.js");
const CONNECTOR_PROBE = join(REPO_ROOT, "connector", "dist", "src", "dev", "streamProbe.js");

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

function heading(text: string): void {
  console.log("");
  console.log("=".repeat(78));
  console.log(text);
  console.log("=".repeat(78));
}

/** Find a port nothing is listening on, then let it go. The gateway must be restartable on
 * the same port across three phases, so an ephemeral port chosen by the gateway is no use. */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.on("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

function portAccepts(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    const finish = (result: boolean): void => {
      socket.destroy();
      done(result);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    setTimeout(() => finish(false), 500);
  });
}

/** A child process whose stdout is captured line by line. */
interface Child {
  readonly name: string;
  readonly process: ChildProcessByStdio<null, Readable, Readable>;
  readonly lines: readonly string[];
  readonly stderr: readonly string[];
  kill(signal?: NodeJS.Signals): Promise<void>;
}

function startChild(
  name: string,
  entry: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Child {
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const lines: string[] = [];
  const stderr: string[] = [];
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    let index = buffered.indexOf("\n");
    while (index !== -1) {
      lines.push(buffered.slice(0, index).replace(/\r$/, ""));
      buffered = buffered.slice(index + 1);
      index = buffered.indexOf("\n");
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => stderr.push(chunk));

  return {
    name,
    process: child,
    get lines(): readonly string[] {
      return lines;
    },
    get stderr(): readonly string[] {
      return stderr;
    },
    kill(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
      return new Promise((done) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          done();
          return;
        }
        child.once("exit", () => done());
        child.kill(signal);
        // Windows has no real SIGKILL semantics through `kill`; the exit event is what is
        // waited on either way, and the timeout keeps a stuck child from hanging the run.
        setTimeout(() => done(), 5_000);
      });
    },
  };
}

async function waitFor(
  what: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  console.log(`  (timed out after ${timeoutMs}ms waiting for ${what})`);
  return false;
}

// ---------------------------------------------------------------------------
// Sample-app log parsing
// ---------------------------------------------------------------------------

interface AppLine {
  readonly app: string;
  readonly event: string;
  readonly n?: number;
  readonly atMs?: number;
  readonly providerId?: string;
  readonly status?: number;
  readonly mode?: string;
  readonly listVersion?: number | null;
  readonly unmet?: string | null;
  readonly ms?: number;
  readonly detail?: string;
}

function appLines(child: Child): AppLine[] {
  const parsed: AppLine[] = [];
  for (const line of child.lines) {
    if (!line.startsWith("{")) continue;
    try {
      parsed.push(JSON.parse(line) as AppLine);
    } catch {
      // A partially flushed line is not evidence of anything; skip it.
    }
  }
  return parsed;
}

interface AccessEntry {
  readonly atMs: number;
  readonly method: string;
  readonly path: string;
}

function accessLog(child: Child): AccessEntry[] {
  const entries: AccessEntry[] = [];
  for (const line of child.lines) {
    if (!line.startsWith("ACCESS ")) continue;
    const [, atMs, method, path] = line.split(" ");
    if (atMs === undefined || method === undefined || path === undefined) continue;
    entries.push({ atMs: Number(atMs), method, path });
  }
  return entries;
}

function countPaths(entries: readonly AccessEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    const key = `${entry.method} ${entry.path}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Gateway HTTP helpers
// ---------------------------------------------------------------------------

interface TargetWorkload {
  readonly allowed_models: readonly string[];
  readonly p95_ms?: number;
  readonly cost_per_1k_tokens_usd?: number;
  readonly objective: string;
}

async function putTargets(
  gatewayUrl: string,
  workloads: Readonly<Record<string, TargetWorkload>>,
): Promise<{ atMs: number; version: number }> {
  const current = await fetch(`${gatewayUrl}/v1/targets`);
  let version = 0;
  if (current.ok) {
    const body = (await current.json()) as { version?: number };
    version = body.version ?? 0;
  } else {
    await current.text();
  }

  const atMs = Date.now();
  const response = await fetch(`${gatewayUrl}/v1/targets`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version, workloads }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`PUT /v1/targets failed with ${response.status}: ${text}`);
  }
  const parsed = JSON.parse(text) as { version: number };
  return { atMs, version: parsed.version };
}

interface StatusResponse {
  readonly workload: string;
  readonly unmet: boolean;
  readonly usage: {
    readonly requestCount: number;
    readonly promptTokens: number;
    readonly completionTokens: number;
    readonly providerLatencyP95Ms: number | string;
  };
  readonly directive: {
    readonly pushedVersion: number;
    readonly pushedAtMs: number;
    readonly ackedVersion: number | null;
    readonly ackedAtMs: number | null;
    readonly deliveryMode: string;
    readonly ackDelayMs: number | null;
  } | null;
}

async function getStatus(gatewayUrl: string, workload: string): Promise<StatusResponse | null> {
  try {
    const response = await fetch(`${gatewayUrl}/v1/workloads/${workload}/status`);
    if (!response.ok) {
      await response.text();
      return null;
    }
    return (await response.json()) as StatusResponse;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

interface CheckResult {
  readonly id: string;
  readonly title: string;
  readonly pass: boolean;
  readonly notes: readonly string[];
}

const results: CheckResult[] = [];

function record(id: string, title: string, pass: boolean, notes: readonly string[]): void {
  results.push({ id, title, pass, notes });
  console.log("");
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${id} — ${title}`);
  for (const note of notes) console.log(`        ${note}`);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

interface Context {
  readonly gatewayUrl: string;
  readonly port: number;
  readonly storePath: string;
  readonly fast: E2eStub;
  readonly cheap: E2eStub;
  readonly stream: E2eStub;
  readonly gatewayEnv: NodeJS.ProcessEnv;
}

function startGateway(context: Context, extra: NodeJS.ProcessEnv = {}): Child {
  return startChild("gateway", GATEWAY_ENTRY, { ...context.gatewayEnv, ...extra }, join(REPO_ROOT, "gateway"));
}

async function waitForGateway(gateway: Child, timeoutMs = 15_000): Promise<boolean> {
  return waitFor(
    "gateway READY",
    () => gateway.lines.some((line) => line.startsWith("READY ")),
    timeoutMs,
  );
}

async function mintToken(gatewayUrl: string, customerId: string = CUSTOMER_ID): Promise<string> {
  const response = await fetch(`${gatewayUrl}/v1/admin/connectors`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify({ customerId }),
  });
  const text = await response.text();
  if (response.status !== 201) {
    throw new Error(`POST /v1/admin/connectors failed with ${response.status}: ${text}`);
  }
  return (JSON.parse(text) as { token: string }).token;
}

function startApp(
  appId: string,
  workload: string,
  gatewayUrl: string,
  token: string,
  fallbackUrl: string,
  fallbackModel: string,
): Child {
  return startChild(
    appId,
    CONNECTOR_APP,
    {
      GATEWAY_URL: gatewayUrl,
      GATEWAY_CONNECTOR_TOKEN: token,
      CONNECTOR_WORKLOAD: workload,
      CONNECTOR_FALLBACK_BASE_URL: fallbackUrl,
      CONNECTOR_FALLBACK_MODEL: fallbackModel,
      E2E_APP_ID: appId,
      E2E_INTERVAL_MS: "250",
    },
    join(REPO_ROOT, "connector"),
  );
}

/**
 * A listener that stands in for the dead gateway, recording when the connector knocks.
 *
 * Answering `503` rather than leaving the port closed is what makes the retry curve
 * observable at all: a refused TCP connect leaves no record anywhere. From the connector's
 * side the two are the same event — no stream, no lists — so the curve measured here is the
 * curve it walks against a gateway that is genuinely gone.
 */
interface RecorderHit {
  readonly atMs: number;
  readonly path: string;
  /** Which connector knocked. Two sample applications share the port, and a curve computed
   * across both is not a curve: their attempts interleave into gaps neither one took. */
  readonly token: string;
}

interface Recorder {
  readonly hits: readonly RecorderHit[];
  close(): Promise<void>;
}

function startRecorder(port: number): Promise<Recorder> {
  const hits: RecorderHit[] = [];
  const server: Server = createServer((req, res) => {
    req.resume();
    const header = req.headers["authorization"];
    const value = Array.isArray(header) ? (header[0] ?? "") : (header ?? "");
    hits.push({
      atMs: Date.now(),
      path: (req.url ?? "").split("?")[0] ?? "",
      token: value.replace(/^Bearer\s+/i, ""),
    });
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "gateway is down (e2e recorder)" }));
  });

  return new Promise((done) => {
    server.listen(port, "127.0.0.1", () => {
      done({
        get hits(): readonly RecorderHit[] {
          return hits;
        },
        close(): Promise<void> {
          return new Promise((closed) => {
            server.closeAllConnections?.();
            server.close(() => closed());
          });
        },
      });
    });
  });
}

/** Drive traffic through the gateway's own data path. Used only where a check has no other
 * way to close a measurement window — see check 7, and the defect it records. */
async function driveInPath(
  gatewayUrl: string,
  workload: string,
  count: number,
): Promise<number> {
  let completed = 0;
  const body = JSON.stringify({ model: "sim", messages: [{ role: "user", content: "window" }] });
  const worker = async (share: number): Promise<void> => {
    for (let index = 0; index < share; index += 1) {
      try {
        const response = await fetch(`${gatewayUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-gateway-workload": workload },
          body,
        });
        await response.text();
        completed += 1;
      } catch {
        // Counted by omission; the caller asserts on `completed`.
      }
    }
  };
  await Promise.all([1, 2, 3, 4].map(() => worker(Math.ceil(count / 4))));
  return completed;
}

async function main(): Promise<number> {
  const storeDir = mkdtempSync(join(tmpdir(), "gateway-e2e-"));
  const storePath = join(storeDir, "store.sqlite");

  const fast = createE2eStub({
    name: FAST.id,
    profile: { latencyMs: 60, costPer1kTokensUsd: 0.03 },
  });
  const cheap = createE2eStub({
    name: CHEAP.id,
    profile: { latencyMs: 300, costPer1kTokensUsd: 0.002 },
  });
  const stream = createE2eStub({
    name: "sim-stream",
    profile: { streamChunkIntervalMs: STREAM_CHUNK_INTERVAL_MS, streamChunks: 3 },
  });

  const children: Child[] = [];
  let gateway: Child | null = null;

  try {
    const fastUrl = await fast.listen();
    const cheapUrl = await cheap.listen();
    const streamUrl = await stream.listen();
    const port = await freePort();
    const gatewayUrl = `http://127.0.0.1:${port}`;

    const gatewayEnv: NodeJS.ProcessEnv = {
      UPSTREAM_BASE_URL: fastUrl,
      PORT: String(port),
      GATEWAY_PROVIDERS: JSON.stringify([
        { id: FAST.id, baseUrl: fastUrl, model: FAST.model, host: FAST.host },
        { id: CHEAP.id, baseUrl: cheapUrl, model: CHEAP.model, host: CHEAP.host },
      ]),
      GATEWAY_STORE_PATH: storePath,
      GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN,
      ...WINDOW,
    };

    const context: Context = { gatewayUrl, port, storePath, fast, cheap, stream, gatewayEnv };

    heading("SETUP");
    console.log(`reproduce with     npm --prefix gateway run e2e`);
    console.log(`gateway            ${gatewayUrl} (child process, access log on stdout)`);
    console.log(`${FAST.model}@${FAST.host}      ${fastUrl}  60ms, $0.03/1k`);
    console.log(`${CHEAP.model}@${CHEAP.host}     ${cheapUrl}  300ms, $0.002/1k`);
    console.log(`stream stub        ${streamUrl}  chunks ${STREAM_CHUNK_INTERVAL_MS}ms apart`);
    console.log(`store              ${storePath}`);
    console.log(`observation window ${OBSERVE_MS}ms (E2E_OBSERVE_MS)`);
    console.log("");
    console.log("DEMO window settings — NOT production defaults (300000ms / 200 req / floor 20):");
    for (const [key, value] of Object.entries(WINDOW)) console.log(`  ${key} = ${value}`);

    gateway = startGateway(context);
    children.push(gateway);
    if (!(await waitForGateway(gateway))) {
      console.log(gateway.stderr.join(""));
      throw new Error("the gateway never became ready");
    }

    // One token per sample application, so the reconnect curve of *one* connector can be
    // separated from the other's on a shared port.
    const token = await mintToken(gatewayUrl);
    const batchToken = await mintToken(gatewayUrl);
    console.log("");
    console.log(
      `minted connector tokens for customer "${CUSTOMER_ID}": ` +
        `${token.slice(0, 8)}... (${DEFAULT_APP}), ${batchToken.slice(0, 8)}... (${BATCH_APP})`,
    );

    // `default` is pinned to the fast stub and `batch` to the cheap one, so both upstreams
    // carry traffic during the observation. Pinning by `allowed_models` rather than by a
    // measured dimension is deliberate and is explained where check 2b records it.
    const initial = await putTargets(gatewayUrl, {
      default: { allowed_models: ALLOWED_BOTH, p95_ms: 400, objective: "p95_ms" },
      batch: {
        allowed_models: ALLOWED_CHEAP_ONLY,
        cost_per_1k_tokens_usd: 0.05,
        objective: "cost_per_1k_tokens_usd",
      },
    });
    console.log(`PUT /v1/targets -> version ${initial.version}`);

    const defaultApp = startApp(DEFAULT_APP, "default", gatewayUrl, token, fastUrl, FAST.model);
    const batchApp = startApp(BATCH_APP, "batch", gatewayUrl, batchToken, cheapUrl, CHEAP.model);
    children.push(defaultApp, batchApp);

    // -----------------------------------------------------------------------
    heading("CHECK 1 — the whole architecture in one observation");
    // -----------------------------------------------------------------------
    const observeFrom = Date.now();
    console.log(`running both sample applications for ${OBSERVE_MS}ms ...`);
    await sleep(OBSERVE_MS);
    const observeTo = Date.now();

    const access = accessLog(gateway).filter(
      (entry) => entry.atMs >= observeFrom && entry.atMs <= observeTo,
    );
    const chatHits = access.filter((entry) => entry.path === "/v1/chat/completions");
    const fastHits = fast.since(observeFrom).length;
    const cheapHits = cheap.since(observeFrom).length;
    const defaultCalls = appLines(defaultApp).filter((line) => line.event === "call").length;
    const batchCalls = appLines(batchApp).filter((line) => line.event === "call").length;

    record(
      "1",
      "no chat completion reaches the gateway while both stubs serve traffic",
      chatHits.length === 0 && fastHits > 0 && cheapHits > 0 && defaultCalls > 0 && batchCalls > 0,
      [
        `gateway access log over the window: ${access.length} requests, ` +
          `${chatHits.length} of them POST /v1/chat/completions`,
        `paths seen: ${JSON.stringify(countPaths(access))}`,
        `stub ${FAST.id} served ${fastHits} requests; stub ${CHEAP.id} served ${cheapHits}`,
        `sample apps completed ${defaultCalls} (default) and ${batchCalls} (batch) calls`,
        "the access log is non-empty, so the observer would have seen a chat completion had one arrived",
      ],
    );

    // -----------------------------------------------------------------------
    heading("CHECK 2b — does a *measured* target move traffic? (control observation)");
    // -----------------------------------------------------------------------
    const beforeMeasured = Date.now();
    await putTargets(gatewayUrl, {
      default: {
        allowed_models: ALLOWED_BOTH,
        cost_per_1k_tokens_usd: 0.005,
        objective: "cost_per_1k_tokens_usd",
      },
      batch: {
        allowed_models: ALLOWED_CHEAP_ONLY,
        cost_per_1k_tokens_usd: 0.05,
        objective: "cost_per_1k_tokens_usd",
      },
    });
    await sleep(SWITCH_BUDGET_MS + 2_000);
    const movedOnCost = cheap.since(beforeMeasured, DEFAULT_APP).length;
    console.log(
      `  after a cost target only ${CHEAP.id} can satisfy ($0.002 vs $0.03), ` +
        `${CHEAP.id} received ${movedOnCost} requests from ${DEFAULT_APP} in ` +
        `${SWITCH_BUDGET_MS + 2000}ms (still on ${FAST.id}: ` +
        `${fast.since(beforeMeasured, DEFAULT_APP).length})`,
    );
    console.log(
      "  This is NOT asserted on: it is recorded because it is the finding. See M1-EVIDENCE.md.",
    );

    // -----------------------------------------------------------------------
    heading("CHECK 2 — a target change moves traffic within five seconds");
    // -----------------------------------------------------------------------
    const switched = await putTargets(gatewayUrl, {
      default: { allowed_models: ALLOWED_CHEAP_ONLY, p95_ms: 5_000, objective: "p95_ms" },
      batch: {
        allowed_models: ALLOWED_CHEAP_ONLY,
        cost_per_1k_tokens_usd: 0.05,
        objective: "cost_per_1k_tokens_usd",
      },
    });
    console.log(`PUT /v1/targets at ${switched.atMs} -> version ${switched.version}`);

    const moved = await waitFor(
      "traffic on the cheap stub from the default workload",
      () => cheap.since(switched.atMs, DEFAULT_APP).length > 0,
      SWITCH_BUDGET_MS + 5_000,
      50,
    );
    const firstMoved = cheap.since(switched.atMs, DEFAULT_APP)[0];
    const switchMs = firstMoved === undefined ? null : firstMoved.atMs - switched.atMs;

    // The last request the *old* provider took, to show the move is a move and not an
    // overlap: a check that only proves the new provider got traffic would pass even if the
    // old one kept getting it too.
    await sleep(2_000);
    const stillFast = fast.since(switched.atMs + (switchMs ?? 0) + 500, DEFAULT_APP).length;

    const statusAfterSwitch = await getStatus(gatewayUrl, "default");
    const directive = statusAfterSwitch?.directive ?? null;
    const ackOk =
      directive !== null &&
      directive.ackedVersion !== null &&
      directive.ackedVersion === directive.pushedVersion;

    record(
      "2",
      "target switch takes effect within five seconds and is acknowledged",
      moved && switchMs !== null && switchMs <= SWITCH_BUDGET_MS && stillFast === 0 && ackOk,
      [
        `PUT committed at ${switched.atMs}; first ${DEFAULT_APP} request on ${CHEAP.id} ` +
          `at ${firstMoved?.atMs ?? "never"} (${switchMs ?? "n/a"}ms, budget ${SWITCH_BUDGET_MS}ms)`,
        `${DEFAULT_APP} requests still reaching ${FAST.id} after the move: ${stillFast}`,
        `directive: ${JSON.stringify(directive)}`,
        ackOk
          ? `the gateway recorded an acknowledgement carrying version ${directive?.ackedVersion}, the version it pushed`
          : "no acknowledgement matching the pushed version was recorded",
      ],
    );

    // -----------------------------------------------------------------------
    heading("CHECK 3 — the status resource reports what only the connector could know");
    // -----------------------------------------------------------------------
    await waitFor(
      "a usage report to land",
      async () => ((await getStatus(gatewayUrl, "default"))?.usage.requestCount ?? 0) > 0,
      20_000,
      500,
    );
    const usageStatus = await getStatus(gatewayUrl, "default");
    const usage = usageStatus?.usage ?? null;
    const usageOk =
      usage !== null &&
      usage.requestCount > 0 &&
      usage.promptTokens > 0 &&
      usage.completionTokens > 0;

    record(
      "3",
      "GET /v1/workloads/default/status reports connector-supplied tokens and latency",
      usageOk,
      [
        `usage: ${JSON.stringify(usage)}`,
        "the gateway forwarded none of these requests (check 1), so the token counts and the",
        "provider-attributable latency exist only because the connector reported them",
        `providerLatencyP95Ms = ${String(usage?.providerLatencyP95Ms)} against a stub configured at 300ms`,
      ],
    );

    // -----------------------------------------------------------------------
    heading("CHECK 3b — a non-default customer's reports are invisible (defect probe)");
    // -----------------------------------------------------------------------
    // Not one of the plan's bullets. It is here because check 3 only passes when the
    // connector is minted under `DEFAULT_CUSTOMER_ID`, and an evidence run that quietly
    // chose the one customer id that works would be hiding the interesting fact.
    const otherToken = await mintToken(gatewayUrl, OTHER_CUSTOMER_ID);
    const beforeOther = (await getStatus(gatewayUrl, "default"))?.usage.requestCount ?? 0;
    const otherPost = await fetch(`${gatewayUrl}/v1/connector/usage`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${otherToken}` },
      body: JSON.stringify({
        records: [
          {
            workload: "default",
            providerId: CHEAP.id,
            model: CHEAP.model,
            region: "local",
            promptTokens: 999,
            completionTokens: 999,
            latencyMs: 42,
            statusCode: 200,
            rateLimitLimit: null,
            rateLimitReset: null,
            reservationId: null,
            atMs: Date.now(),
          },
        ],
        strainDropped: 0,
        usageDropped: 0,
      }),
    });
    await otherPost.text();
    await sleep(1_000);
    const afterOther = (await getStatus(gatewayUrl, "default"))?.usage.requestCount ?? 0;
    console.log(
      `  POST /v1/connector/usage as customer "${OTHER_CUSTOMER_ID}" -> ${otherPost.status}; ` +
        `status usage.requestCount ${beforeOther} -> ${afterOther} ` +
        `(the 999-token record is accepted and then unreadable)`,
    );
    console.log("  Recorded, not asserted. See M1-EVIDENCE.md, Defect 3.");

    // -----------------------------------------------------------------------
    heading("CHECK 4 — the gateway dies and the sample application does not");
    // -----------------------------------------------------------------------
    const usageBeforeKill = usage?.requestCount ?? 0;
    const killedAtMs = Date.now();
    await gateway.kill("SIGKILL");
    console.log(`killed the gateway (SIGKILL) at ${killedAtMs}`);
    await waitFor("the gateway port to stop accepting", async () => !(await portAccepts(port)), 5_000);

    const outageFrom = Date.now();
    await sleep(10_000);
    const duringOutage = appLines(defaultApp).filter(
      (line) => (line.atMs ?? 0) >= outageFrom,
    );
    const outageCalls = duringOutage.filter((line) => line.event === "call");
    const outageErrors = duringOutage.filter((line) => line.event === "error");
    const outageOnCheap = cheap.since(outageFrom, DEFAULT_APP).length;
    const outageOnFast = fast.since(outageFrom, DEFAULT_APP).length;

    console.log(
      `  during 10s with no gateway: ${outageCalls.length} calls, ${outageErrors.length} errors, ` +
        `${outageOnCheap} to ${CHEAP.id} (the last-directed stub), ${outageOnFast} to ${FAST.id}`,
    );

    // The retry curve, measured by a listener standing where the gateway was, and read for
    // one connector only.
    const recorder = await startRecorder(port);
    const recorderFrom = Date.now();
    const RECORD_MS = 75_000;
    console.log(`  recording reconnect attempts for ${RECORD_MS}ms ...`);
    await sleep(RECORD_MS);
    const streamKnocks = recorder.hits
      .filter((hit) => hit.path === "/v1/connector/stream" && hit.token === token)
      .map((hit) => hit.atMs - recorderFrom);
    // Usage batches the connector tried to deliver while the gateway was gone. `report.ts`
    // discards a failed batch rather than requeueing it, so each of these is a report that
    // no longer exists anywhere — the precise, bounded sense in which something *is* lost.
    const lostBatches = recorder.hits.filter(
      (hit) => hit.path === "/v1/connector/usage" && hit.token === token,
    ).length;
    const gaps: number[] = [];
    for (let index = 1; index < streamKnocks.length; index += 1) {
      gaps.push((streamKnocks[index] ?? 0) - (streamKnocks[index - 1] ?? 0));
    }
    await recorder.close();

    // "Backs off rather than spins" is a claim about the *shape* of the curve, so it is
    // asserted as one: every gap is seconds rather than milliseconds, the gaps do not
    // shrink, and the curve reaches the documented cap region. A count-based check would
    // pass on a fixed one-second retry, which is precisely the failure being excluded.
    // Recording starts after the port has already been closed for ten seconds, so the
    // early half-second attempts are behind us and the curve observed here is its tail.
    const firstGap = gaps[0] ?? 0;
    const lastGap = gaps[gaps.length - 1] ?? 0;
    const monotonic = gaps.every((gap, index) => index === 0 || gap >= (gaps[index - 1] ?? 0) * 0.9);
    const backsOff =
      gaps.length >= 2 && gaps.every((gap) => gap >= 2_000) && monotonic && lastGap >= 8_000;
    console.log(`  reconnect attempts at (ms from recorder start): ${streamKnocks.join(", ")}`);
    console.log(`  gaps between attempts: ${gaps.join(", ")}`);

    // Restart on the same port, same store.
    gateway = startGateway(context);
    children.push(gateway);
    const restarted = await waitForGateway(gateway);
    const restartAtMs = Date.now();
    const recovered = await waitFor(
      "the sample application to be pushed a list again",
      () => {
        const lines = appLines(defaultApp);
        const recent = lines.filter((line) => (line.atMs ?? 0) >= restartAtMs);
        return recent.some((line) => line.mode === "push");
      },
      60_000,
      500,
    );
    // Reporting resumed is the recovery claim, not a cumulative total: the status resource's
    // usage lookback is three window spans, which is three seconds under this demo's window
    // settings, so a running total is not a quantity it can report.
    const reportingResumed = await waitFor(
      "usage reports to start landing again",
      async () => ((await getStatus(gatewayUrl, "default"))?.usage.requestCount ?? 0) > 0,
      30_000,
      500,
    );
    const usageAfterRestart = (await getStatus(gatewayUrl, "default"))?.usage.requestCount ?? 0;

    record(
      "4",
      "killing the gateway leaves traffic untouched; reconnects back off; restart recovers",
      outageCalls.length > 0 &&
        outageErrors.length === 0 &&
        outageOnCheap > 0 &&
        outageOnFast === 0 &&
        backsOff &&
        restarted &&
        recovered &&
        reportingResumed,
      [
        `with the gateway gone: ${outageCalls.length} calls completed, ${outageErrors.length} failed, ` +
          `all ${outageOnCheap} to ${CHEAP.id} — the stub the last directive named`,
        `reconnect attempts (ms from t0): ${streamKnocks.join(", ")}`,
        `gaps: ${gaps.join(", ")} — first ${firstGap}ms, last ${lastGap}ms ` +
          `(${backsOff ? "growing, not spinning" : "NOT a backoff curve"})`,
        `after restart the connector is on mode=push again: ${recovered}`,
        `usage reporting resumed: ${reportingResumed} ` +
          `(requestCount ${usageBeforeKill} before the kill, ${usageAfterRestart} after the restart; ` +
          "this is a three-second trailing lookback under the demo window, not a running total)",
        `usage batches the connector attempted and lost during the outage: ${lostBatches} ` +
          "— report.ts discards a failed batch by design rather than requeueing it",
      ],
    );

    // -----------------------------------------------------------------------
    heading("CHECK 5 — degraded polling mode");
    // -----------------------------------------------------------------------
    await gateway.kill("SIGKILL");
    await waitFor("the gateway port to stop accepting", async () => !(await portAccepts(port)), 5_000);
    gateway = startGateway(context, { GATEWAY_SSE_DISABLED: "1" });
    children.push(gateway);
    const sseDisabledReady = await waitForGateway(gateway);
    const pollFrom = Date.now();

    // A target change made while only polling works: the connector must still pick it up.
    await sleep(2_000);
    const polledTarget = await putTargets(gatewayUrl, {
      default: { allowed_models: ALLOWED_CHEAP_ONLY, p95_ms: 4_000, objective: "p95_ms" },
      batch: {
        allowed_models: ALLOWED_CHEAP_ONLY,
        cost_per_1k_tokens_usd: 0.05,
        objective: "cost_per_1k_tokens_usd",
      },
    });

    const polled = await waitFor(
      "the sample application to report mode=poll with a list in hand",
      () =>
        appLines(defaultApp).some(
          (line) =>
            (line.atMs ?? 0) >= pollFrom && line.mode === "poll" && (line.listVersion ?? 0) > 0,
        ),
      90_000,
      500,
    );
    await sleep(5_000);
    const pollStatus = await getStatus(gatewayUrl, "default");
    const pollDirective = pollStatus?.directive ?? null;
    const lastPollLine = [...appLines(defaultApp)]
      .reverse()
      .find((line) => line.event === "call" && (line.atMs ?? 0) >= pollFrom);

    const streamRefused = await fetch(`${gatewayUrl}/v1/connector/stream`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const streamStatus = streamRefused.status;
    await streamRefused.text();

    record(
      "5",
      "with SSE refused the connector still receives lists, and the mode is visible to the gateway",
      sseDisabledReady && polled && streamStatus === 503 && pollDirective?.deliveryMode === "poll",
      [
        `GET /v1/connector/stream while GATEWAY_SSE_DISABLED=1 -> ${streamStatus}`,
        `sample app line while degraded: ${JSON.stringify(lastPollLine)}`,
        `target written during the outage was version ${polledTarget.version}`,
        `directive as the gateway sees it: ${JSON.stringify(pollDirective)}`,
        `deliveryMode=${pollDirective?.deliveryMode ?? "n/a"}, ackDelayMs=${String(pollDirective?.ackDelayMs)}`,
      ],
    );

    // -----------------------------------------------------------------------
    heading("CHECK 6 — streaming time-to-first-byte");
    // -----------------------------------------------------------------------
    const probe = startChild(
      "stream-probe",
      CONNECTOR_PROBE,
      {
        PROBE_PROVIDER_URL: streamUrl,
        PROBE_CHUNK_INTERVAL_MS: String(STREAM_CHUNK_INTERVAL_MS),
      },
      join(REPO_ROOT, "connector"),
    );
    children.push(probe);
    await waitFor("the stream probe to finish", () => probe.process.exitCode !== null, 30_000, 200);

    const probeLine = probe.lines.find((line) => line.startsWith("{"));
    const probeResult =
      probeLine === undefined
        ? null
        : (JSON.parse(probeLine) as {
            ok: boolean;
            ttfbMs: number | null;
            totalMs: number;
            chunks: number;
            arrivalsMs: number[];
          });
    const ttfb = probeResult?.ttfbMs ?? null;
    const total = probeResult?.totalMs ?? 0;
    // ~1s, not "after the last chunk". Both bounds matter: a fast TTFB with a fast total
    // would mean the stub never spaced its chunks, and the measurement would be vacuous.
    const streamingOk =
      probeResult?.ok === true &&
      ttfb !== null &&
      ttfb >= STREAM_CHUNK_INTERVAL_MS * 0.8 &&
      ttfb <= STREAM_CHUNK_INTERVAL_MS * 1.8 &&
      total >= STREAM_CHUNK_INTERVAL_MS * 2.5 &&
      total - ttfb >= STREAM_CHUNK_INTERVAL_MS * 1.5;

    record("6", "a streamed response reaches the caller incrementally", streamingOk, [
      `probe: ${probeLine ?? "(no output)"}`,
      `time-to-first-byte ${ttfb ?? "n/a"}ms against chunks ${STREAM_CHUNK_INTERVAL_MS}ms apart`,
      `total ${total}ms — the first byte arrived ${total - (ttfb ?? 0)}ms before the stream ended,`,
      "which is the measurement a buffering relay cannot produce",
    ]);

    // -----------------------------------------------------------------------
    heading("CHECK 7 — the unmet header, written by the connector");
    // -----------------------------------------------------------------------
    // Restore the push channel first: the header rides on the ranked list, so the connector
    // must be able to receive a new one promptly.
    await gateway.kill("SIGKILL");
    await waitFor("the gateway port to stop accepting", async () => !(await portAccepts(port)), 5_000);
    gateway = startGateway(context);
    children.push(gateway);
    await waitForGateway(gateway);
    await waitFor(
      "the connector back on the push channel",
      () => {
        const now = Date.now();
        return appLines(defaultApp).some(
          (line) => (line.atMs ?? 0) >= now - 5_000 && line.mode === "push",
        );
      },
      60_000,
      500,
    );

    // Degrade the cheap stub instead of stating an impossible number.
    //
    // A `p95_ms` of 50 is rejected `422 infeasible_by_declaration` — the capability floor
    // says the best achievable on this provider is 380ms, and refusing a target nothing
    // could ever hold is the gateway working correctly. `unmet` is the *observed* state, so
    // reaching it requires a target that was feasible when written and a provider that then
    // fails to hold it. Slowing the stub to 900ms against a declarable 400ms target is
    // exactly that.
    cheap.setProfile({ latencyMs: 900 });
    console.log(`  degraded ${CHEAP.id} to 900ms so a declarable target stops being held`);

    const unmetTarget = await putTargets(gatewayUrl, {
      default: { allowed_models: ALLOWED_CHEAP_ONLY, p95_ms: 400, objective: "p95_ms" },
      batch: {
        allowed_models: ALLOWED_CHEAP_ONLY,
        cost_per_1k_tokens_usd: 0.05,
        objective: "cost_per_1k_tokens_usd",
      },
    });
    console.log(`PUT an unmeetable p95_ms target -> version ${unmetTarget.version}`);

    // The point of this check, and the reason it is worth its runtime: `unmet` must be
    // reachable from the connector's usage reports alone. The gateway is out of the request
    // path in normal operation, so if closing a measurement window required the gateway's
    // own data path then `unmet` — and with it every measured dimension and the ranked
    // list's reordering — could never happen for a real customer. An earlier run of this
    // harness had to drive 160 in-path requests here; that was a real defect, not a
    // property of the test, and the fix was to fold reported calls into the rolling windows
    // at ingestion. This block therefore issues **no** in-path traffic at all, and the
    // assertion below is what keeps it that way.
    const inPathBefore = Date.now();

    const wentUnmet = await waitFor(
      "the workload to enter unmet on the connector's reports alone",
      async () => ((await getStatus(gatewayUrl, "default"))?.unmet ?? false) === true,
      60_000,
      500,
    );

    // The connector batches usage every ten seconds, so reaching two consecutive missed
    // windows takes a few report cycles; the wait above is sized for that, not for a hang.
    const inPathRequests = accessLog(gateway).filter(
      (entry) => entry.atMs >= inPathBefore && entry.path === "/v1/chat/completions",
    ).length;
    const unmetFromConnectorTrafficAlone = wentUnmet && inPathRequests === 0;

    const headerFrom = Date.now();
    const headerSeen = await waitFor(
      "the sample application's responses to carry x-gateway-target-unmet",
      () =>
        appLines(defaultApp).some(
          (line) => (line.atMs ?? 0) >= headerFrom && typeof line.unmet === "string",
        ),
      30_000,
      250,
    );
    const headerLine = appLines(defaultApp)
      .filter((line) => (line.atMs ?? 0) >= headerFrom && typeof line.unmet === "string")
      .at(0);

    record(
      "7",
      "responses the gateway never saw carry x-gateway-target-unmet",
      wentUnmet && headerSeen && inPathRequests === 0,
      [
        `unmet reached on connector reports alone: ${String(unmetFromConnectorTrafficAlone)}`,
        `in-path requests used to get there: ${inPathRequests} (must be 0)`,
        `workload entered unmet: ${wentUnmet}`,
        `sample app line carrying the header: ${JSON.stringify(headerLine)}`,
        "the connector wrote this header onto a response the gateway never handled",
      ],
    );

    // -----------------------------------------------------------------------
    heading("SUMMARY");
    // -----------------------------------------------------------------------
    for (const result of results) {
      console.log(`${result.pass ? "PASS" : "FAIL"}  ${result.id}  ${result.title}`);
    }
    const failed = results.filter((result) => !result.pass);
    console.log("");
    console.log(`${results.length - failed.length}/${results.length} checks passed`);
    return failed.length === 0 ? 0 : 1;
  } finally {
    for (const child of children) await child.kill("SIGKILL");
    await fast.close();
    await cheap.close();
    await stream.close();
    rmSync(storeDir, { recursive: true, force: true });
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error("[e2e] failed:", error);
    process.exitCode = 1;
  });
