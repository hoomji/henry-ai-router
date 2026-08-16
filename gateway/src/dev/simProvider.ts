import { createServer } from "node:http";
import type { Server } from "node:http";

/**
 * A simulated upstream with controllable characteristics.
 *
 * M1's `stubUpstream.ts` is a fixture: one canned answer, no timing, no cost. M2's claim
 * is that the *split changes when the target changes*, and that claim cannot be shown
 * against identical upstreams. This module is the difference: two of these, given
 * deliberately different latency and price, are what make routing's choice observable
 * without a single provider credential.
 *
 * Cost is reported as a response header rather than derived from tokens because M2 has no
 * token accounting layer. The unit rate is the thing routing compares; inventing a token
 * counter to multiply it by would add a second source of error to a demonstration whose
 * whole point is that the first one is visible.
 */
export interface SimProfile {
  /** Mean provider-attributable latency before jitter. */
  readonly latencyMs: number;
  /** Uniform +/- spread around `latencyMs`, so p95 is meaningfully above p50. */
  readonly jitterMs: number;
  /** The unit rate this provider bills, echoed on every response. */
  readonly costPer1kTokensUsd: number;
  /** Probability in [0, 1] that a request is answered 503 instead of 200. */
  readonly errorRate: number;
}

/** A running sim provider, and the handle used to degrade or restore it mid-run. */
export interface SimProvider {
  readonly server: Server;
  readonly profile: SimProfile;
  /** Takes effect on the *next* request. No restart, because the verification steps
   * degrade a provider mid-run and then restore it while load is still flowing. */
  setProfile(next: Partial<SimProfile>): void;
  readonly url: string;
}

/** A `Server` that also carries the profile controls, so callers can `listen()` it. */
export type SimProviderServer = Server & {
  setProfile(next: Partial<SimProfile>): void;
  readonly profile: SimProfile;
};

/** Header carrying the simulated unit rate, so the caller can attribute cost. */
export const SIM_COST_HEADER = "x-sim-cost-per-1k-usd";
/** Header naming which sim answered, so a split can be counted from responses alone. */
export const SIM_PROVIDER_HEADER = "x-sim-provider";

/** Change the profile of a sim provider over HTTP, for one this process did not start. */
export const SIM_PROFILE_PATH = "/_sim/profile";

const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

function sleep(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

function completionBody(name: string): string {
  return JSON.stringify({
    id: `chatcmpl-${name}`,
    object: "chat.completion",
    model: name,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: `simulated response from ${name}` },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 4, total_tokens: 4 },
  });
}

function readBody(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
  });
}

/**
 * Merge a partial profile, field by field.
 *
 * Spelled out rather than spread because `exactOptionalPropertyTypes` makes a spread of a
 * `Partial` able to write an explicit `undefined` over a real number.
 */
function mergeProfile(current: SimProfile, next: Partial<SimProfile>): SimProfile {
  return {
    latencyMs: next.latencyMs ?? current.latencyMs,
    jitterMs: next.jitterMs ?? current.jitterMs,
    costPer1kTokensUsd: next.costPer1kTokensUsd ?? current.costPer1kTokensUsd,
    errorRate: next.errorRate ?? current.errorRate,
  };
}

/** Accept only the numeric fields we know, so a typo in a POST body is not silent. */
function parseProfilePatch(raw: string): Partial<SimProfile> | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { error: `body is not valid JSON: ${String(error)}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { error: "body must be a JSON object" };
  }
  const record = parsed as Record<string, unknown>;
  const patch: {
    latencyMs?: number;
    jitterMs?: number;
    costPer1kTokensUsd?: number;
    errorRate?: number;
  } = {};
  const fields = ["latencyMs", "jitterMs", "costPer1kTokensUsd", "errorRate"] as const;
  for (const key of Object.keys(record)) {
    if (!(fields as readonly string[]).includes(key)) {
      return { error: `unknown profile field: ${key}` };
    }
  }
  for (const field of fields) {
    const value = record[field];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return { error: `${field} must be a non-negative finite number` };
    }
    patch[field] = value;
  }
  return patch;
}

/**
 * Header naming the reserved model a request addressed, or absent when it addressed none.
 *
 * The verification step that matters is "the traffic moved onto the reservation without the
 * sample application's own code changing", and the only honest evidence for it is the
 * provider reporting which endpoint it actually served. A header the caller cannot influence
 * is that evidence; counting requests at the connector would be the connector grading itself.
 */
export const SIM_ADDRESSED_HEADER = "x-sim-addressed-model";

/** The `model` field of a chat-completions body, or `null` when there is not one. */
function requestedModel(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const model = (parsed as Record<string, unknown>)["model"];
    return typeof model === "string" ? model : null;
  } catch {
    return null;
  }
}

export function createSimProvider(options: {
  name: string;
  profile: SimProfile;
  /**
   * The host-specific string that addresses this sim's *reserved* capacity, if it sells any.
   *
   * A provisioned model ARN on Bedrock and a deployment name on Azure are both just an opaque
   * string the caller puts in the `model` field, which is exactly why the mistake this
   * milestone reports on is so easy to make: passing the foundation name instead is answered
   * normally, billed on demand, and looks identical from the call site. The sim reproduces
   * that — both identifiers are served — and differs only in what it says it served.
   */
  addressingModel?: string;
}): SimProviderServer {
  const { name, addressingModel } = options;
  let profile = options.profile;
  const body = completionBody(name);
  /** A distinct model name, so a reservation-addressing call is visible in the stub's log. */
  const reservedName = `${name}-provisioned`;
  const reservedBody = completionBody(reservedName);

  const server = createServer((req, res) => {
    const url = req.url ?? "";

    if (req.method === "POST" && url === SIM_PROFILE_PATH) {
      void readBody(req).then((raw) => {
        const patch = parseProfilePatch(raw);
        if ("error" in patch) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: patch.error }));
          return;
        }
        profile = mergeProfile(profile, patch);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(profile));
      });
      return;
    }

    if (req.method !== "POST" || url !== CHAT_COMPLETIONS_PATH) {
      req.resume();
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `no such sim route: ${req.method ?? "?"} ${url}` }));
      return;
    }

    // Read the profile once per request, so a `setProfile` during the sleep applies to
    // the next request rather than retroactively to this one.
    const active = profile;

    void readBody(req).then(async (raw) => {
      const jitter = active.jitterMs === 0 ? 0 : (Math.random() * 2 - 1) * active.jitterMs;
      await sleep(Math.max(0, active.latencyMs + jitter));

      const addressed =
        addressingModel !== undefined && requestedModel(raw) === addressingModel;

      const headers: Record<string, string> = {
        "content-type": "application/json",
        [SIM_PROVIDER_HEADER]: addressed ? reservedName : name,
        [SIM_COST_HEADER]: String(active.costPer1kTokensUsd),
      };
      if (addressed) headers[SIM_ADDRESSED_HEADER] = addressingModel ?? "";

      if (Math.random() < active.errorRate) {
        res.writeHead(503, headers);
        res.end(JSON.stringify({ error: { message: "simulated overload", type: "sim_error" } }));
        return;
      }

      res.writeHead(200, headers);
      res.end(addressed ? reservedBody : body);
    });
  });

  const controlled = Object.assign(server, {
    setProfile(next: Partial<SimProfile>): void {
      profile = mergeProfile(profile, next);
    },
  });

  // `defineProperty` rather than a getter in the `Object.assign` literal: assign copies a
  // getter's *value*, which would freeze `.profile` at its starting state and quietly
  // misreport a degraded provider as healthy.
  Object.defineProperty(controlled, "profile", {
    enumerable: true,
    get: (): SimProfile => profile,
  });

  return controlled as SimProviderServer;
}
