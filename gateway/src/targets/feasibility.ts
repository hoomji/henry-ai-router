import type {
  CapabilityFloor,
  DimensionName,
  FeasibilityResult,
  InfeasibilityReport,
  Workload,
} from "../types.js";
import { DIMENSION_NAMES, isCeiling } from "../types.js";
import { bestFloor, floorsFor, isStale } from "../providers/capabilities.js";

/**
 * The declaration-time feasibility check.
 *
 * `infeasible_by_declaration` means no allowed provider plausibly *can* satisfy the target
 * — knowable before any traffic flows. It runs synchronously when the target document is
 * written, and a rejection rejects the write. That is the whole point of the outcome: the
 * customer learns their target is impossible while they are still typing it, rather than
 * from an `unmet` state hours later
 * (docs/adr/0001-declaration-time-vs-observed-infeasibility.md).
 *
 * Two rules shape everything below, and both bias the check against itself:
 *
 *  - Rejection must clear the floor's own variance. A target that merely fails the most
 *    optimistic floor is accepted; only one that fails it by more than that floor's
 *    variance is rejected. We would rather accept a target that later proves unmeetable —
 *    `unmet` exists to catch that — than reject one that was achievable.
 *  - Absent or stale evidence never rejects. When nothing trustworthy is known the check
 *    abstains and the write is accepted, and the abstention is reported so a status
 *    resource can show that the target was accepted unchecked rather than verified.
 *
 * Pure: the candidate set comes from the workload, the evidence from the catalogue passed
 * in, and the current time from `nowMs`.
 */
export function checkFeasibility(
  workload: Workload,
  nowMs: number,
  catalogue?: readonly CapabilityFloor[],
): FeasibilityResult {
  const reports: InfeasibilityReport[] = [];
  const staleDimensions: DimensionName[] = [];

  // DIMENSION_NAMES rather than Object.keys, so the report order is the vocabulary's order
  // and not whatever order the document happened to be serialized in.
  for (const dimension of DIMENSION_NAMES) {
    const requested = workload.dimensions[dimension];
    if (requested === undefined) continue;

    // `allowed_models` is required precisely because it is what makes this computable: it
    // is the bounded candidate set the target has to be plausible against.
    const candidates: CapabilityFloor[] = [];
    for (const allowed of workload.allowedModels) {
      candidates.push(...floorsFor(allowed.model, allowed.host, dimension, catalogue));
    }

    const trusted = candidates.filter((floor) => !isStale(floor, nowMs));
    const best = bestFloor(trusted, dimension);
    if (best === null) {
      // Either no candidate has a floor on this dimension at all, or every one that does is
      // past its TTL. Both are absent evidence, and absent evidence never rejects.
      staleDimensions.push(dimension);
      continue;
    }

    // The variance band is the bias against itself: `<`/`>` on the band's far edge, so a
    // target sitting exactly on it is accepted.
    const rejected = isCeiling(dimension)
      ? requested < best.value - best.variance
      : requested > best.value + best.variance;
    if (!rejected) continue;

    reports.push({
      workload: workload.name,
      dimension,
      requested,
      bestAchievable: best.value,
      providerId: best.providerId,
      model: best.model,
      host: best.host,
      floorProvenance: best.provenance,
      // Disclosed rather than derived by the reader: the age is part of the basis, and a
      // reader holding only the report cannot recompute it.
      floorAgeMs: nowMs - best.observedAtMs,
      assumption: best.assumption ?? null,
    });
  }

  // A genuine rejection outranks an abstention. Abstaining on one dimension says nothing
  // about a target that is demonstrably impossible on another.
  if (reports.length > 0) {
    return { status: "infeasible", reports };
  }

  if (staleDimensions.length > 0) {
    return {
      status: "abstained",
      staleDimensions,
      detail: abstentionDetail(workload.name, staleDimensions),
    };
  }

  return { status: "feasible" };
}

/**
 * The abstention's human-readable basis.
 *
 * The acceptance criteria require abstention to be observable, and a status resource can
 * only show a sentence. It names the dimensions so a reader can tell "we checked and it is
 * fine" from "we could not check".
 */
function abstentionDetail(
  workload: string,
  staleDimensions: readonly DimensionName[],
): string {
  const named = staleDimensions.join(", ");
  const plural = staleDimensions.length === 1 ? "dimension" : "dimensions";
  return (
    `Feasibility abstained for workload "${workload}": no capability floor for ${plural} ` +
    `${named} could be trusted (every candidate floor is stale or absent), so the target ` +
    `was accepted without being checked on ${staleDimensions.length === 1 ? "it" : "them"}.`
  );
}
