import { INSUFFICIENT_DATA, holdsTarget } from "../types.js";
import type {
  DimensionName,
  ProviderObservation,
  RejectionReason,
  UnmetReport,
  UnmetState,
  Workload,
} from "../types.js";

/**
 * The `unmet` two-window state machine.
 *
 * Pure: a window's verdict is computed from a snapshot handed in, and time only ever
 * arrives as an explicit argument. The store persists what this module returns; it never
 * reaches the store itself, which is what keeps `targets/` free of I/O apart from
 * `targets/store.ts`.
 *
 * `unmet` is one of the spec's two infeasibility states, and the two must never be
 * collapsed: `infeasible_by_declaration` says no allowed provider *plausibly can* hold the
 * target and is knowable before any traffic flows, while `unmet` says no mix of allowed
 * providers *has* held it over the measurement window
 * (docs/adr/0001-declaration-time-vs-observed-infeasibility.md).
 */

/** How a closed window ended, once the state machine has folded it in. */
export interface UnmetEvaluation {
  readonly state: UnmetState;
  /**
   * Set on the window that crosses a boundary, and only then. The caller turns this into
   * exactly one notification, having first won the store's compare-and-set.
   */
  readonly transition: "entered" | "left" | null;
}

/** A window's verdict before the streak logic sees it. */
export type WindowVerdict = "held" | "missed" | "indeterminate";

/** The blank state a workload starts from. */
export function initialState(workload: string): UnmetState {
  return {
    workload,
    unmet: false,
    since: null,
    report: null,
    missedStreak: 0,
    heldStreak: 0,
    lastWindowAtMs: null,
  };
}

function observedFor(
  observation: ProviderObservation | undefined,
  dimension: DimensionName,
): number | typeof INSUFFICIENT_DATA {
  if (observation === undefined) return INSUFFICIENT_DATA;
  switch (dimension) {
    case "p95_ms":
      return observation.p95Ms;
    case "cost_per_1k_tokens_usd":
      return observation.costPer1kTokensUsd;
    case "success_rate":
      return observation.successRate;
  }
}

/**
 * Pick the observation that came closest to holding the dimension.
 *
 * The report says what the customer's traffic actually achieved, so it must quote the
 * best any allowed provider managed rather than an average that no single provider ever
 * delivered.
 */
function bestObserved(
  candidates: readonly ProviderObservation[],
  dimension: DimensionName,
): number | typeof INSUFFICIENT_DATA {
  let best: number | typeof INSUFFICIENT_DATA = INSUFFICIENT_DATA;
  const better = (a: number, b: number): boolean =>
    dimension === "success_rate" ? a > b : a < b;

  for (const candidate of candidates) {
    const value = observedFor(candidate, dimension);
    if (value === INSUFFICIENT_DATA) continue;
    if (best === INSUFFICIENT_DATA || better(value, best)) best = value;
  }
  return best;
}

/**
 * Decide what one closed window says about the target.
 *
 * Three outcomes rather than two, because a window in which nothing could be measured is
 * not a window in which the target was missed. Below the sample floor a dimension has no
 * value at all, and accruing a missed window from absent evidence would let a quiet period
 * raise `unmet` — the opposite of a diagnosis. This is also why a workload can be `unmet`
 * and `insufficient_data` at once for the first window after a restart: the flag survived,
 * the measurements did not.
 */
export function judgeWindow(
  workload: Workload,
  observations: readonly ProviderObservation[],
): { verdict: WindowVerdict; dimension: DimensionName | null } {
  const stated = workload.declarationOrder.filter(
    (dimension) => workload.dimensions[dimension] !== undefined,
  );
  if (stated.length === 0) return { verdict: "held", dimension: null };

  let anyMeasured = false;
  for (const dimension of stated) {
    for (const observation of observations) {
      if (observedFor(observation, dimension) !== INSUFFICIENT_DATA) anyMeasured = true;
    }
  }
  if (!anyMeasured || observations.length === 0) {
    return { verdict: "indeterminate", dimension: null };
  }

  // "No mix of allowed providers has held the target": the window is held when some
  // allowed provider held every stated dimension over it.
  const holder = observations.find((observation) =>
    stated.every((dimension) => {
      const target = workload.dimensions[dimension];
      if (target === undefined) return true;
      const observed = observedFor(observation, dimension);
      // Absent evidence never convicts, here for the same reason it never disqualifies a
      // candidate in `chooseProvider`.
      if (observed === INSUFFICIENT_DATA) return true;
      return holdsTarget(dimension, observed, target);
    }),
  );
  if (holder !== undefined) return { verdict: "held", dimension: null };

  // Report the highest-priority dimension no provider held: `priority` is
  // highest-first, so the first match is the one the customer cares most about.
  const ordered = workload.priority.filter((dimension) => stated.includes(dimension));
  const search = ordered.length > 0 ? ordered : stated;
  const atFault =
    search.find((dimension) => {
      const target = workload.dimensions[dimension];
      if (target === undefined) return false;
      return !observations.some((observation) => {
        const observed = observedFor(observation, dimension);
        return observed !== INSUFFICIENT_DATA && holdsTarget(dimension, observed, target);
      });
    }) ??
    search[0] ??
    null;

  return { verdict: "missed", dimension: atFault };
}

/**
 * Fold one closed window into the state.
 *
 * Entry and exit are deliberately symmetric — two consecutive missed windows in, two
 * consecutive held windows out. The symmetry is what stops the state flapping around a
 * target sitting near the boundary; a faster exit is not an improvement and must not be
 * "optimized" in later.
 */
export function foldWindow(
  previous: UnmetState | null,
  workload: Workload,
  observations: readonly ProviderObservation[],
  rejections: readonly RejectionReason[],
  window: { closedAtMs: number; spanMs: number; requestCount: number },
): UnmetEvaluation {
  const state = previous ?? initialState(workload.name);
  const { verdict, dimension } = judgeWindow(workload, observations);

  if (verdict === "indeterminate") {
    // Neither streak moves: an unmeasurable window is not evidence either way.
    return {
      state: { ...state, lastWindowAtMs: window.closedAtMs },
      transition: null,
    };
  }

  const missedStreak = verdict === "missed" ? state.missedStreak + 1 : 0;
  const heldStreak = verdict === "held" ? state.heldStreak + 1 : 0;

  let unmet = state.unmet;
  let since = state.since;
  let report = state.report;
  let transition: "entered" | "left" | null = null;

  if (!unmet && missedStreak >= 2) {
    unmet = true;
    since = window.closedAtMs;
    transition = "entered";
  } else if (unmet && heldStreak >= 2) {
    unmet = false;
    since = null;
    report = null;
    transition = "left";
  }

  if (unmet && dimension !== null) {
    const target = workload.dimensions[dimension];
    if (target !== undefined) {
      report = {
        dimension,
        target,
        observed: bestObserved(observations, dimension),
        windowSpanMs: window.spanMs,
        windowRequestCount: window.requestCount,
        // Both reports are diagnoses, not alarms: `unmet` must say, for each candidate
        // provider, why it was not selected.
        rejections,
      } satisfies UnmetReport;
    }
  }

  return {
    state: {
      workload: workload.name,
      unmet,
      since,
      report,
      missedStreak,
      heldStreak,
      lastWindowAtMs: window.closedAtMs,
    },
    transition,
  };
}

/**
 * Restore persisted state at boot.
 *
 * A workload's `unmet` state survives a gateway restart; its measurement window does not.
 * Counters older than roughly two windows of downtime describe windows nobody can still
 * vouch for, so they are discarded while the flag itself is kept — the flag is the
 * customer-visible claim, the counters are only how it was reached
 * (docs/adr/0002-durable-target-store-with-cross-process-concurrency.md).
 */
export function restoreState(
  stored: UnmetState | null,
  nowMs: number,
  windowMs: number,
): UnmetState | null {
  if (stored === null) return null;
  if (stored.lastWindowAtMs === null) return stored;

  const downtimeMs = nowMs - stored.lastWindowAtMs;
  if (downtimeMs <= windowMs * 2) return stored;

  return { ...stored, missedStreak: 0, heldStreak: 0 };
}
