/**
 * A read-only snapshot of everything the control plane durably knows.
 *
 * The gateway's whole job is a decision — which provider a workload's traffic should go to,
 * and why — and until now that decision was only observable by standing up a server, minting
 * a connector token, and reading `GET /v1/workloads/{name}/status` per workload. That is a
 * lot of apparatus for the question an engineer or an agent actually asks after a failing
 * `run e2e` or `run load`: *what does the gateway currently believe?*
 *
 * So this reads the store directly, needs no running process, and answers that question in
 * one command. Three properties make it safe to point at a live system:
 *
 * - It only reads. There is no write path in this file, and the store is SQLite in WAL mode,
 *   so a reader gets a consistent view while the gateway holds the write lock.
 * - It goes through `TargetStore`, not through `node:sqlite`. The design doc's rule that
 *   exactly one module knows the on-disk shape still holds, so a data plane rewritten in
 *   another language replaces one file rather than two.
 * - The ranked list it prints is `computeRankedList`, the same function the control plane
 *   pushes from, over a state snapshot built the same way `TargetService` builds it. A
 *   debugging view that computed its own ordering would be a second router, and the one
 *   nobody tests is the one that lies to you at 3am.
 *
 * Connector tokens are bearer credentials with no expiry, so they are printed truncated. The
 * useful facts — how many connectors exist and when they were minted — survive redaction;
 * the credential does not need to be on a terminal or in a transcript to answer them.
 *
 * Usage (after `npm --prefix gateway run build`):
 *
 *     npm --prefix gateway run inspect
 *     npm --prefix gateway run inspect -- --json
 *     npm --prefix gateway run inspect -- --store ./gateway-store.sqlite --customer default
 */

import { existsSync } from "node:fs";

import { loadConfig } from "../config.js";
import { computeRankedList, type RankedListDraft } from "../controlplane/rankedList.js";
import { mergeObservations } from "../routing/stats.js";
import { ackDelayMs, StoreUnavailableError, TargetStore } from "../targets/store.js";
import type { ConnectorDirective } from "../targets/store.js";
import { INSUFFICIENT_DATA, reservationIsLive } from "../types.js";
import type {
  DimensionName,
  Provider,
  ProviderObservation,
  Reservation,
  UnmetState,
} from "../types.js";

/** How the providers in the snapshot were obtained, so a surprising list is explicable. */
export type ProviderSource = "GATEWAY_PROVIDERS" | "UPSTREAM_BASE_URL passthrough" | "assumed";

export interface ReservationSnapshot {
  readonly id: string;
  readonly model: string;
  readonly host: string;
  readonly region: string;
  readonly addressingModel: string;
  readonly effectiveRatePer1kTokensUsd: number;
  readonly termStartMs: number;
  readonly termEndMs: number;
  /** Whether the term covers the instant this snapshot was taken. */
  readonly live: boolean;
}

export interface DirectiveSnapshot {
  readonly pushedVersion: number;
  readonly pushedAtMs: number;
  readonly ackedVersion: number | null;
  readonly ackedAtMs: number | null;
  readonly deliveryMode: string;
  readonly ackDelayMs: number | null;
  /**
   * True when the connector has not acknowledged the version currently outstanding.
   *
   * The single most useful derived fact in the whole snapshot: it is the difference between
   * "the gateway decided" and "the connector is running that decision", and every routing
   * bug that looks like the policy being wrong turns out to be this being true.
   */
  readonly stale: boolean;
}

export interface WorkloadSnapshot {
  readonly workload: string;
  readonly unmet: boolean;
  readonly unmetDimension: DimensionName | null;
  readonly since: number | null;
  readonly missedStreak: number;
  readonly heldStreak: number;
  readonly lastWindowAtMs: number | null;
  /** Merged over the same trailing lookback the service reports on: three window spans. */
  readonly observations: readonly ProviderObservation[];
  readonly windowSummaryCount: number;
  readonly directive: DirectiveSnapshot | null;
  readonly reportedRequestCount: number;
  readonly reportedPromptTokens: number;
  readonly reportedCompletionTokens: number;
  /** `null` when no provider catalogue could be resolved; see `providerSource`. */
  readonly rankedList: RankedListDraft | null;
}

export interface StoreSnapshot {
  readonly storePath: string;
  readonly customerId: string;
  readonly atMs: number;
  readonly windowMs: number;
  readonly sampleFloor: number;
  readonly providerSource: ProviderSource;
  readonly providers: readonly Provider[];
  readonly targetVersion: number;
  readonly notifyUrl: string | null;
  readonly reservationVersion: number;
  readonly reservations: readonly ReservationSnapshot[];
  readonly connectors: readonly { readonly tokenPrefix: string; readonly createdAtMs: number }[];
  readonly workloads: readonly WorkloadSnapshot[];
}

export interface SnapshotOptions {
  readonly storePath: string;
  readonly providers: readonly Provider[];
  readonly providerSource: ProviderSource;
  readonly nowMs: number;
  readonly windowMs: number;
  readonly sampleFloor: number;
}

/**
 * Build the snapshot from an already-open store.
 *
 * Separated from the command so it can be tested against a store built row by row, without a
 * process, a port, or a clock. Everything time-dependent arrives in `options`.
 */
export function buildSnapshot(store: TargetStore, options: SnapshotOptions): StoreSnapshot {
  const { nowMs, windowMs, sampleFloor } = options;
  // The same trailing lookback `TargetService` uses for the observations it routes on. A
  // different one here would make the snapshot disagree with the running gateway about what
  // has been measured, which is the one thing a debugging view must never do.
  const sinceMs = nowMs - windowMs * 3;

  const document = store.readDocument();
  const reservationDocument = store.readReservations();
  const declared: readonly Reservation[] = reservationDocument?.reservations ?? [];
  const liveReservations = declared.filter((reservation) =>
    reservationIsLive(reservation, nowMs),
  );

  const usageTotals = store.readUsageTotals(sinceMs);
  const workloadNames = Object.keys(document?.workloads ?? {}).sort();

  const workloads = workloadNames.map((name): WorkloadSnapshot => {
    const workload = document?.workloads[name] ?? null;
    const summaries = store.readWindowSummaries(name, sinceMs);
    const observations = mergeObservations(summaries, sampleFloor);
    const unmet: UnmetState | null = store.readUnmetState(name);
    const directive = store.readDirective(name);
    const totals = usageTotals.find((entry) => entry.workload === name);
    const unmetDimension =
      unmet !== null && unmet.unmet ? (unmet.report?.dimension ?? null) : null;

    return {
      workload: name,
      unmet: unmet?.unmet ?? false,
      unmetDimension,
      since: unmet?.since ?? null,
      missedStreak: unmet?.missedStreak ?? 0,
      heldStreak: unmet?.heldStreak ?? 0,
      lastWindowAtMs: unmet?.lastWindowAtMs ?? null,
      observations: Object.values(observations),
      windowSummaryCount: summaries.length,
      directive: directive === null ? null : toDirectiveSnapshot(directive),
      reportedRequestCount: totals?.requestCount ?? 0,
      reportedPromptTokens: totals?.promptTokens ?? 0,
      reportedCompletionTokens: totals?.completionTokens ?? 0,
      rankedList:
        workload === null || options.providers.length === 0
          ? null
          : computeRankedList(
              name,
              {
                providers: options.providers,
                observations,
                workload,
                liveReservations,
              },
              { unmetDimension, computedAtMs: nowMs },
            ),
    };
  });

  return {
    storePath: options.storePath,
    customerId: store.customerId,
    atMs: nowMs,
    windowMs,
    sampleFloor,
    providerSource: options.providerSource,
    providers: options.providers,
    targetVersion: store.readVersion(),
    notifyUrl: document?.notifyUrl ?? null,
    reservationVersion: store.readReservationVersion(),
    reservations: declared.map((reservation) => ({
      id: reservation.id,
      model: reservation.model,
      host: reservation.host,
      region: reservation.region,
      addressingModel: reservation.addressingModel,
      effectiveRatePer1kTokensUsd: reservation.effectiveRatePer1kTokensUsd,
      termStartMs: reservation.termStartMs,
      termEndMs: reservation.termEndMs,
      live: reservationIsLive(reservation, nowMs),
    })),
    connectors: store.listConnectors().map((record) => ({
      // Enough to correlate a connector's logs with a row here, far too little to use.
      tokenPrefix: `${record.token.slice(0, 8)}…`,
      createdAtMs: record.createdAtMs,
    })),
    workloads,
  };
}

function toDirectiveSnapshot(directive: ConnectorDirective): DirectiveSnapshot {
  return {
    pushedVersion: directive.pushedVersion,
    pushedAtMs: directive.pushedAtMs,
    ackedVersion: directive.ackedVersion,
    ackedAtMs: directive.ackedAtMs,
    deliveryMode: directive.deliveryMode,
    ackDelayMs: ackDelayMs(directive),
    stale: directive.ackedVersion !== directive.pushedVersion,
  };
}

function measured(value: number | typeof INSUFFICIENT_DATA): string {
  return value === INSUFFICIENT_DATA ? "insufficient_data" : String(value);
}

/**
 * Render the snapshot as text.
 *
 * Text is the default rather than JSON because the common case is a human or an agent reading
 * the output in a terminal transcript, and the facts that matter — is it unmet, is the
 * connector on the current list, what is the order — should be legible without a parser.
 * `--json` is there for when something downstream is doing the reading.
 */
export function renderSnapshot(snapshot: StoreSnapshot): string {
  const lines: string[] = [];
  lines.push(`store        ${snapshot.storePath}`);
  lines.push(`customer     ${snapshot.customerId}`);
  lines.push(`at           ${new Date(snapshot.atMs).toISOString()} (${snapshot.atMs})`);
  lines.push(
    `window       ${snapshot.windowMs}ms, sample floor ${snapshot.sampleFloor}, ` +
      `lookback ${snapshot.windowMs * 3}ms`,
  );
  lines.push(
    `providers    ${snapshot.providers.length} from ${snapshot.providerSource}` +
      (snapshot.providers.length === 0 ? " — ranked lists omitted" : ""),
  );
  lines.push(`targets      version ${snapshot.targetVersion}, notifyUrl ${snapshot.notifyUrl ?? "none"}`);
  lines.push(
    `reservations version ${snapshot.reservationVersion}, ${snapshot.reservations.length} declared, ` +
      `${snapshot.reservations.filter((reservation) => reservation.live).length} live`,
  );
  for (const reservation of snapshot.reservations) {
    lines.push(
      `  - ${reservation.id} ${reservation.live ? "live" : "expired/future"} ` +
        `${reservation.model}@${reservation.host}/${reservation.region} ` +
        `as ${reservation.addressingModel} at $${reservation.effectiveRatePer1kTokensUsd}/1k`,
    );
  }
  lines.push(`connectors   ${snapshot.connectors.length} minted`);
  for (const connector of snapshot.connectors) {
    lines.push(`  - ${connector.tokenPrefix} minted ${new Date(connector.createdAtMs).toISOString()}`);
  }

  if (snapshot.workloads.length === 0) {
    lines.push("");
    lines.push("No workload has been declared: nobody has written a target document.");
    return lines.join("\n");
  }

  for (const workload of snapshot.workloads) {
    lines.push("");
    lines.push(`workload ${workload.workload}`);
    lines.push(
      `  unmet      ${workload.unmet ? `yes (${workload.unmetDimension ?? "unknown"})` : "no"}` +
        `, missed streak ${workload.missedStreak}, held streak ${workload.heldStreak}` +
        (workload.since === null ? "" : `, since ${new Date(workload.since).toISOString()}`),
    );
    lines.push(
      `  measured   ${workload.observations.length} providers over ${workload.windowSummaryCount} window summaries`,
    );
    for (const observation of workload.observations) {
      lines.push(
        `    - ${observation.providerId}: p95 ${measured(observation.p95Ms)}ms, ` +
          `cost ${measured(observation.costPer1kTokensUsd)}, ` +
          `success ${measured(observation.successRate)}, n=${observation.sampleCount}`,
      );
    }
    if (workload.directive === null) {
      lines.push("  directive  none delivered");
    } else {
      const directive = workload.directive;
      lines.push(
        `  directive  pushed v${directive.pushedVersion} by ${directive.deliveryMode}, ` +
          `acked ${directive.ackedVersion ?? "never"}` +
          (directive.ackDelayMs === null ? "" : ` after ${directive.ackDelayMs}ms`) +
          (directive.stale ? "  <-- STALE: the connector is not on the current list" : ""),
      );
    }
    lines.push(
      `  reported   ${workload.reportedRequestCount} calls, ` +
        `${workload.reportedPromptTokens} prompt + ${workload.reportedCompletionTokens} completion tokens`,
    );
    if (workload.rankedList === null) {
      lines.push("  ranked     unavailable — no provider catalogue resolved");
    } else {
      lines.push(`  ranked     bound by ${workload.rankedList.boundBy ?? "nothing"}`);
      workload.rankedList.providers.forEach((provider, index) => {
        lines.push(
          `    ${index + 1}. ${provider.providerId} ${provider.model}@${provider.host}/${provider.region}` +
            (provider.reservationId === null
              ? ""
              : ` (reservation ${provider.reservationId} as ${provider.addressingModel ?? "?"})`),
        );
      });
      if (workload.rankedList.providers.length < snapshot.providers.length) {
        lines.push(
          `    (truncated: a hard dimension could not be held by the remaining providers)`,
        );
      }
    }
  }

  return lines.join("\n");
}

/**
 * Resolve the provider catalogue without inventing one.
 *
 * `loadConfig` is the only module allowed to read the environment, so the catalogue is
 * obtained by calling it rather than by parsing `GATEWAY_PROVIDERS` a second time here. It
 * requires `UPSTREAM_BASE_URL`, which an operator inspecting a store after the fact may well
 * not have set — so an absent one is substituted with a placeholder and the substitution is
 * reported as `assumed`, because a passthrough provider pointing at a URL nobody configured
 * must not be mistaken for the catalogue the gateway was actually running.
 */
function resolveProviders(env: NodeJS.ProcessEnv): {
  providers: readonly Provider[];
  source: ProviderSource;
} {
  const declared = env["GATEWAY_PROVIDERS"];
  const upstream = env["UPSTREAM_BASE_URL"];
  const source: ProviderSource =
    declared !== undefined && declared.trim() !== ""
      ? "GATEWAY_PROVIDERS"
      : upstream !== undefined && upstream.trim() !== ""
        ? "UPSTREAM_BASE_URL passthrough"
        : "assumed";

  try {
    const config = loadConfig({ ...env, UPSTREAM_BASE_URL: upstream ?? "http://localhost:8081" });
    return { providers: config.providers, source };
  } catch (error) {
    console.error(`[inspect] provider catalogue unavailable: ${String(error)}`);
    return { providers: [], source };
  }
}

function argumentValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

export function main(argv: readonly string[], env: NodeJS.ProcessEnv): number {
  const storePath =
    argumentValue(argv, "--store") ?? env["GATEWAY_STORE_PATH"] ?? "gateway-store.sqlite";
  const customerId = argumentValue(argv, "--customer") ?? "default";
  const { providers, source } = resolveProviders(env);

  if (!existsSync(storePath)) {
    // `TargetStore.open` would happily create the file, and an empty store that the command
    // just created reads exactly like a gateway that has never been written to. Refusing is
    // the honest answer: the operator pointed at the wrong path.
    console.error(`[inspect] no store at ${storePath}; pass --store or set GATEWAY_STORE_PATH`);
    return 1;
  }

  let store: TargetStore;
  try {
    store = TargetStore.open(storePath, customerId);
  } catch (error) {
    // An unopenable store is the answer, not a crash: it is exactly what the gateway itself
    // would have degraded on, and the operator's next move is to check the path.
    console.error(
      error instanceof StoreUnavailableError
        ? `[inspect] ${error.message}`
        : `[inspect] cannot open ${storePath}: ${String(error)}`,
    );
    return 1;
  }

  try {
    const snapshot = buildSnapshot(store, {
      storePath,
      providers,
      providerSource: source,
      nowMs: Date.now(),
      windowMs: Number(env["GATEWAY_WINDOW_MS"] ?? 300_000),
      sampleFloor: Number(env["GATEWAY_SAMPLE_FLOOR"] ?? 20),
    });
    console.log(
      argv.includes("--json") ? JSON.stringify(snapshot, null, 2) : renderSnapshot(snapshot),
    );
    return 0;
  } finally {
    store.close();
  }
}

// Guarded so the test can import `buildSnapshot` without running the command.
if (process.argv[1]?.endsWith("inspect.js") === true) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
