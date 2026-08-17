import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import { loadConfig, ConfigError } from "../config.js";
import { createGateway } from "../server.js";

/**
 * The one check in this repository that is allowed to leave the laptop.
 *
 * It starts a real gateway, mints a connector token from it exactly the way
 * `POST /v1/admin/connectors` is documented to work, and makes the connector place one real
 * chat-completion call against a real provider — the same `connector.call()` code path
 * `sampleApp.ts` and `e2eApp.ts` exercise against stubs, run here through
 * `realProviderProbe.ts` instead.
 *
 * Opt-in and never run by anything but a person: `scripts/check.py` and
 * `.github/workflows/gate.yml` never invoke this, because a real call costs a real
 * provider's money or quota and needs a credential this repository must never hold (see
 * `.gitignore`). It requires `PROVIDER_API_KEY` and fails with remediation rather than
 * silently skipping when that credential is absent — the point of running this by hand is
 * to find out whether a real call still works, and a quiet no-op would hide that.
 *
 * This is a smoke test, not a measured capability floor: one call proves the path is
 * reachable today, not a latency percentile a target could be checked against (see
 * docs/references/2026-08-15-provider-capability-floors.md). Passing does not move
 * `real_provider_verification` to `verified` by itself — that also needs this command's
 * output captured as evidence, per docs/harness/manifest.yaml.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
/** `dist/src/dev` -> repository root. */
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const CONNECTOR_PROBE = join(REPO_ROOT, "connector", "dist", "src", "dev", "realProviderProbe.js");

const ADMIN_TOKEN = "real-provider-check-admin-token";
const CUSTOMER_ID = "default";

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

async function mintToken(gatewayUrl: string): Promise<string> {
  const response = await fetch(`${gatewayUrl}/v1/admin/connectors`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ customerId: CUSTOMER_ID }),
  });
  const text = await response.text();
  if (response.status !== 201) {
    throw new Error(`POST /v1/admin/connectors failed with ${response.status}: ${text}`);
  }
  return (JSON.parse(text) as { token: string }).token;
}

interface ProbeResult {
  readonly exitCode: number | null;
  readonly lines: readonly string[];
}

/** Spawned as a separate process and package, deliberately: the connector is a component a
 * customer installs into their own application, and importing its dist output directly from
 * the gateway would add exactly the cross-package dependency the two runtimes' separation is
 * meant to rule out. */
function runProbe(env: NodeJS.ProcessEnv): Promise<ProbeResult> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [CONNECTOR_PROBE], {
      cwd: join(REPO_ROOT, "connector"),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const lines: string[] = [];
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
    const stderrChunks: string[] = [];
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderrChunks.push(chunk));

    child.on("exit", (code) => {
      if (stderrChunks.length > 0) process.stderr.write(stderrChunks.join(""));
      done({ exitCode: code, lines });
    });
  });
}

interface ProbeLine {
  readonly event: "call" | "error";
  readonly providerId?: string;
  readonly status?: number;
  readonly ms?: number;
  readonly detail?: string;
}

async function main(): Promise<number> {
  const apiKey = process.env["PROVIDER_API_KEY"];
  if (apiKey === undefined || apiKey.trim() === "") {
    console.log("FAIL  PROVIDER_API_KEY is not set.");
    console.log("");
    console.log("This check calls a real provider and needs a real credential — it will not");
    console.log("run without one, and it will not silently skip either. Set PROVIDER_API_KEY");
    console.log("(and optionally REAL_PROVIDER_BASE_URL / REAL_PROVIDER_MODEL, which default");
    console.log("to a free OpenRouter model) and rerun:");
    console.log("");
    console.log("  npm --prefix gateway run real-provider-check");
    return 1;
  }

  const baseUrl = process.env["REAL_PROVIDER_BASE_URL"] ?? "https://openrouter.ai/api";
  const model = process.env["REAL_PROVIDER_MODEL"] ?? "google/gemma-4-26b-a4b-it:free";

  const storeDir = mkdtempSync(join(tmpdir(), "gateway-real-provider-check-"));
  let gateway: Server | null = null;

  try {
    const config = loadConfig({
      UPSTREAM_BASE_URL: baseUrl,
      // Parsed but unused: this run listens on an ephemeral port it picks itself below, the
      // same affordance `load.ts` uses so this cannot collide with a gateway already running.
      PORT: "8080",
      GATEWAY_STORE_PATH: join(storeDir, "store.sqlite"),
      GATEWAY_ADMIN_TOKEN: ADMIN_TOKEN,
      GATEWAY_PROVIDERS: JSON.stringify([
        { id: "real-provider-check", baseUrl, model, host: "real-provider-check" },
      ]),
    });
    gateway = createGateway(config);
    const gatewayUrl = await listen(gateway);

    console.log(`gateway   ${gatewayUrl}`);
    console.log(`provider  ${baseUrl}`);
    console.log(`model     ${model}`);

    const token = await mintToken(gatewayUrl);
    console.log(`minted a connector token for customer "${CUSTOMER_ID}"`);

    const probe = await runProbe({
      GATEWAY_URL: gatewayUrl,
      GATEWAY_CONNECTOR_TOKEN: token,
      CONNECTOR_WORKLOAD: "default",
      CONNECTOR_FALLBACK_BASE_URL: baseUrl,
      CONNECTOR_FALLBACK_MODEL: model,
      PROVIDER_API_KEY: apiKey,
    });

    const jsonLine = probe.lines.find((line) => line.startsWith("{"));
    const parsed = jsonLine === undefined ? null : (JSON.parse(jsonLine) as ProbeLine);

    if (parsed === null) {
      console.log("FAIL  the connector probe printed no result.");
      for (const line of probe.lines) console.log(`  ${line}`);
      return 1;
    }

    if (parsed.event === "error") {
      console.log(`FAIL  the connector could not complete the call: ${parsed.detail ?? "unknown error"}`);
      return 1;
    }

    const pass =
      probe.exitCode === 0 &&
      parsed.status !== undefined &&
      parsed.status >= 200 &&
      parsed.status < 300;
    console.log(
      `${pass ? "PASS" : "FAIL"}  provider=${parsed.providerId ?? "?"} status=${parsed.status ?? "?"} ` +
        `ms=${parsed.ms ?? "?"}`,
    );
    if (!pass) {
      console.log("");
      console.log("A non-2xx status means the credential, the model name, or the provider's");
      console.log("own availability is the next thing to check — this script proves");
      console.log("connectivity, not why a particular call failed.");
    }
    return pass ? 0 : 1;
  } catch (error) {
    console.log(`FAIL  ${error instanceof ConfigError ? `configuration error: ${error.message}` : String(error)}`);
    return 1;
  } finally {
    if (gateway !== null) await close(gateway);
    rmSync(storeDir, { recursive: true, force: true });
  }
}

main().then((code) => process.exit(code));
