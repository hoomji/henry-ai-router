import { holdsTarget, INSUFFICIENT_DATA } from "../types.js";
import type {
  DimensionName,
  GatewayRequest,
  Measured,
  Provider,
  ProviderObservation,
  ProviderState,
  RejectionReason,
  Reservation,
  RoutingDecision,
  Workload,
} from "../types.js";
import { providerMatchesAllowed } from "../targets/document.js";

/**
 * The routing seam.
 *
 * Pure over a state snapshot: it performs no I/O, reads no clock, and touches no
 * configuration. That is what lets the same function later compute the ranked list pushed
 * to the connector rather than a per-request choice
 * (docs/adr/0006-routing-authority-stays-gateway-side.md), and what keeps a future Rust or
 * Go data plane a re-expression of this policy rather than a rewrite of it.
 *
 * Everything the decision rests on is a return value. Infeasibility is data — a hard
 * dimension that cannot be held yields `provider: null` and `failedHard`, never a throw —
 * because "a routing decision that cannot produce its binding reason is not acceptable"
 * and a reason reconstructed from logs after the fact is not trustworthy
 * (docs/adr/0001-declaration-time-vs-observed-infeasibility.md).
 *
 * Reservations arrive the same way everything else does — resolved into the snapshot. A
 * reservation's term is a question about a clock, so `state.liveReservations` holds only the
 * ones already live at the instant the snapshot was built. That is what lets a term expire
 * and change the routing decision without this function ever learning what time it is.
 *
 * The one exception left is a defect, not a policy outcome: a snapshot carrying no
 * candidates at all. The fail-open wrapper in `server.ts` — not this function — owns what
 * happens when routing cannot decide.
 */
export function chooseProvider(
  _request: GatewayRequest,
  state: ProviderState,
): RoutingDecision {
  if (state.providers.length === 0) {
    throw new Error("no provider available: ProviderState carries no candidates");
  }

  const workload = state.workload ?? null;
  const rejected: RejectionReason[] = [];

  // No workload means no target at all: every provider is a candidate and nothing binds.
  const candidates: Provider[] = [];
  for (const provider of state.providers) {
    if (workload === null || providerMatchesAllowed(provider, workload.allowedModels)) {
      candidates.push(provider);
      continue;
    }
    // Rule 1: an allowed_models exclusion is not a dimension, but it is still a reason.
    // Leaving it out would make the report incomplete for exactly the provider an
    // operator is most likely to be asking about.
    rejected.push({
      providerId: provider.id,
      dimension: null,
      observed: null,
      target: null,
      reason:
        `provider ${provider.id} serves ${provider.model}@${provider.host}, which is ` +
        `outside the allowed_models of workload ${workload.name}`,
    });
  }

  const stated = workload === null ? [] : statedDimensions(workload);

  // Rule 6: yield one dimension at a time, lowest priority first, and re-evaluate. The
  // loop starts with every stated dimension active, so the first pass is the unrelaxed
  // policy; a target that is satisfiable never reaches the second pass.
  const yieldOrder = workload === null ? [] : yieldableDimensions(workload, stated);
  let active = stated;
  let yielded: DimensionName | null = null;
  let breaches = evaluate(candidates, active, state, workload);
  let survivors = candidates.filter((provider) => (breaches.get(provider.id) ?? []).length === 0);

  for (const yieldable of yieldOrder) {
    if (survivors.length > 0) {
      break;
    }
    active = active.filter((dimension) => dimension !== yieldable);
    // `yielded` names the dimension that had to give way; when several did, the last one
    // is the deepest concession and therefore the one worth reporting.
    yielded = yieldable;
    breaches = evaluate(candidates, active, state, workload);
    survivors = candidates.filter((provider) => (breaches.get(provider.id) ?? []).length === 0);
  }

  if (survivors.length === 0) {
    // Rule 7: conceding has stopped — either everything yieldable has yielded or the hard
    // dimension halted it — and nothing holds what remains. The request fails rather than
    // being served in breach. `failedHard` names the hard dimension only when there were
    // candidates to hold it; with an empty candidate set the failure is the allowed_models
    // exclusion above, and blaming a dimension for it would misdirect the operator.
    for (const provider of candidates) {
      rejected.push(...(breaches.get(provider.id) ?? []));
    }
    return {
      provider: null,
      // Nothing survived, so the objective separated nothing; only a ceiling can have bound this.
      boundBy: workload === null ? null : boundByOf(workload, false, breaches, active),
      yielded,
      failedHard: candidates.length === 0 ? null : (workload?.hard ?? null),
      rejected,
    };
  }

  for (const provider of candidates) {
    rejected.push(...(breaches.get(provider.id) ?? []));
  }

  const objective = objectiveDimension(workload);
  const chosen = pickMinimizer(survivors, objective, state);

  // Rule 4's losers are still part of the report: a survivor that held every target and
  // lost only on the objective is the case an operator most often wants explained. Losing
  // to an unmeasured provider is a different sentence from losing on the number, and an
  // operator watching a measured provider lose deserves to be told it was exploration
  // rather than a comparison they cannot reproduce.
  const exploring = effectiveObserved(objective, chosen, state) === INSUFFICIENT_DATA;
  const chosenReservation = reservationFor(chosen, state);
  for (const provider of survivors) {
    if (provider.id === chosen.id) {
      continue;
    }
    rejected.push({
      providerId: provider.id,
      dimension: objective,
      observed: effectiveObserved(objective, provider, state),
      target: workload === null ? null : (workload.dimensions[objective] ?? null),
      reason: exploring
        ? `provider ${provider.id} held every stated target, but ${chosen.id} has no ` +
          `measured ${objective} yet and was explored first so it can be compared on merit`
        : chosenReservation !== null && reservationFor(provider, state) === null
          ? `provider ${provider.id} held every stated target but sells on demand; ` +
            `${chosen.id} addresses reservation ${chosenReservation.id}, which is capacity ` +
            `already paid for`
          : `provider ${provider.id} held every stated target but did not minimize ` +
            `${objective}; ${chosen.id} did`,
    });
  }

  // The objective "discriminated" only if it had a real choice to make: more than one
  // survivor, holding more than one distinct objective value.
  const objectiveDiscriminated =
    survivors.length > 1 &&
    new Set(survivors.map((provider) => effectiveObserved(objective, provider, state))).size > 1;

  return {
    provider: chosen,
    boundBy: workload === null ? null : boundByOf(workload, objectiveDiscriminated, breaches, active),
    yielded,
    failedHard: null,
    rejected,
  };
}

/**
 * The live reservation this provider addresses, or `null`.
 *
 * The whole reservation branch of this module hangs off this function returning `null`, and
 * it returns `null` immediately when the customer has declared none. That is the inertness
 * the milestone's rollback story depends on: with no reservations the cost lookup, the
 * preference, and the ranked list's addressing string are all exactly what they were before.
 *
 * Liveness is not decided here — `state.liveReservations` is *already* filtered by the
 * snapshot's builder, because deciding it would mean reading a clock and the seam reads no
 * clock. Model, host and region must all match: reserved capacity is bought for one model on
 * one host in one region, and a provider serving the same model elsewhere cannot address it.
 */
function reservationFor(provider: Provider, state: ProviderState): Reservation | null {
  const live = state.liveReservations;
  if (live === undefined || live.length === 0) {
    return null;
  }
  return (
    live.find(
      (reservation) =>
        reservation.model === provider.model &&
        reservation.host === provider.host &&
        reservation.region === provider.region,
    ) ?? null
  );
}

/**
 * What a dimension costs *this customer* on this provider.
 *
 * Only cost moves, and only under a reservation. A reservation is a price, not a promise
 * about latency or reliability — the reserved endpoint is the same silicon — so quoting a
 * reservation against `p95_ms` or `success_rate` would be inventing evidence.
 *
 * This is the first time `cost_per_1k_tokens_usd` is customer-specific rather than a
 * property of the catalogue, which the capability catalogue's global key deliberately does
 * not express (#12, docs/adr/0003-*). The catalogue keeps answering the declaration-time
 * question — can *anyone* plausibly do this — while the routing decision answers what this
 * customer will actually pay, and those are different questions with different keys.
 *
 * The reservation rate is used in place of the *observed* rate rather than alongside it. The
 * observed rate is what the on-demand mix billed; under a reservation the customer is not
 * billed that, so carrying it into the comparison would hold them to a price they no longer
 * pay.
 */
function effectiveObserved(
  dimension: DimensionName,
  provider: Provider,
  state: ProviderState,
): Measured {
  if (dimension === "cost_per_1k_tokens_usd") {
    const reservation = reservationFor(provider, state);
    if (reservation !== null) {
      return reservation.effectiveRatePer1kTokensUsd;
    }
  }
  return observedFor(dimension, state.observations[provider.id]);
}

/** The dimensions a workload actually stated, in declaration order. */
function statedDimensions(workload: Workload): DimensionName[] {
  return workload.declarationOrder.filter(
    (dimension) => workload.dimensions[dimension] !== undefined,
  );
}

/**
 * The order stated dimensions give way in, and where conceding stops.
 *
 * `priority` is highest-priority-first, so its reverse is the order of concession. A
 * dimension the customer stated but left out of `priority` has no claim to precedence, so
 * it concedes before anything ranked.
 *
 * The hard dimension does not merely get skipped over — it TRUNCATES the list. Relaxation
 * walks strictly from the lowest priority upward, so reaching the hard dimension means
 * every cheaper concession has already been spent and the only ones left are more
 * important than a dimension the customer forbade us to concede at all. Conceding one of
 * those to keep the request alive inverts the customer's own ordering. Skipping past the
 * hard dimension to yield the ceiling above it was the bug: it served a request the
 * customer had ruled out, which is the single outcome `hard` exists to prevent.
 */
function yieldableDimensions(
  workload: Workload,
  stated: readonly DimensionName[],
): DimensionName[] {
  const unranked = stated.filter((dimension) => !workload.priority.includes(dimension));
  const ranked = stated
    .filter((dimension) => workload.priority.includes(dimension))
    .sort((a, b) => workload.priority.indexOf(b) - workload.priority.indexOf(a));

  const concessionOrder = [...unranked, ...ranked];
  const hard = workload.hard;
  const halt = hard === null ? -1 : concessionOrder.indexOf(hard);
  return halt === -1 ? concessionOrder : concessionOrder.slice(0, halt);
}

/** The quantity to minimize: the stated objective, or cost when none was stated. */
function objectiveDimension(workload: Workload | null): DimensionName {
  if (workload === null || workload.objective === "none") {
    // "Hold the cheapest satisfying mix": with no objective, cost is the tie-breaker.
    return "cost_per_1k_tokens_usd";
  }
  return workload.objective;
}

/** The observed value of one dimension, with a missing observation read as absent data. */
function observedFor(
  dimension: DimensionName,
  observation: ProviderObservation | undefined,
): Measured {
  if (observation === undefined) {
    return INSUFFICIENT_DATA;
  }
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
 * Which active dimensions each candidate breaches.
 *
 * Rule 3, stated once and deliberately: `insufficient_data` NEVER disqualifies. A provider
 * with no measured value cannot be *shown* to breach a target, and the spec forbids
 * inventing a percentile from a handful of requests. Treating absent data as a breach
 * would quietly route around every provider we have not yet measured — including a brand
 * new one — so absence is read as satisfying the dimension, not failing it.
 */
function evaluate(
  candidates: readonly Provider[],
  active: readonly DimensionName[],
  state: ProviderState,
  workload: Workload | null,
): Map<string, RejectionReason[]> {
  const breaches = new Map<string, RejectionReason[]>();

  for (const provider of candidates) {
    const reasons: RejectionReason[] = [];
    for (const dimension of active) {
      const target = workload?.dimensions[dimension];
      if (target === undefined) {
        continue;
      }
      const observed = effectiveObserved(dimension, provider, state);
      if (observed === INSUFFICIENT_DATA || holdsTarget(dimension, observed, target)) {
        continue;
      }
      const reservation = reservationFor(provider, state);
      const basis =
        dimension === "cost_per_1k_tokens_usd" && reservation !== null
          ? ` at reservation ${reservation.id}'s effective rate`
          : "";
      reasons.push({
        providerId: provider.id,
        dimension,
        observed,
        target,
        reason:
          `provider ${provider.id} observed ${dimension} of ${observed}${basis}, which ` +
          `breaches the stated target of ${target}`,
      });
    }
    breaches.set(provider.id, reasons);
  }

  return breaches;
}

/**
 * Rule 4's ordering, as a comparison.
 *
 * A provider whose objective value is `insufficient_data` sorts FIRST, ahead of every
 * measured one. This looks backwards and is the most important line in the module.
 *
 * Sorting the unmeasured LAST is locally sensible and globally self-defeating, because it
 * closes a loop: at cold start every provider is unmeasured, so the id tie-break picks one;
 * that one accumulates samples and becomes measured; every other provider receives zero
 * requests, so it never accumulates samples, so it stays unmeasured, so it sorts last
 * forever. A provider that is never chosen can never be measured, and a provider that can
 * never be measured can never be chosen. The M2 load run proved it: under a p95 target and
 * under a cost target, one provider took 100.0% of traffic both times and the 15x cheaper
 * provider took 0.0% — the target could not change the routing decision, because the
 * decision had stopped depending on evidence it refused to go and get.
 *
 * So: gathering the evidence IS the objective while the evidence does not exist. The
 * preference is bounded and self-terminating rather than a permanent tax — once a provider
 * clears the sample floor it is measured and competes on its merits, so exploration costs
 * at most one sample floor's worth of requests per provider per window.
 *
 * Do not "optimize" this back to preferring what we have already measured.
 *
 * This is not rule 3. Rule 3 (in `evaluate`) says absent evidence never CONVICTS a
 * provider on a ceiling; this says absent evidence is worth going out and collecting.
 *
 * Exact ties — including two providers that are both unmeasured — break on provider id,
 * because two processes must reach the same decision from the same snapshot and "whichever
 * the array happened to hold first" is not a decision two processes share.
 *
 * Ahead of all of that sits the reservation preference, and its position is the argument for
 * it. It ranks *survivors*, so it can only ever pick between providers that already held
 * every stated target — which is what makes it a preference rather than an override. It
 * cannot reach a provider outside `allowed_models`, because that exclusion happened before
 * any of this and is the customer's blast radius, not a price question: a reservation is not
 * permission to leave the list. It cannot breach a `hard` dimension, because a provider that
 * breached one is not a survivor.
 *
 * It also sits ahead of the exploration rule, which is the one place this looks like it
 * contradicts the paragraphs above. It does not: exploration exists because a decision that
 * stops depending on evidence stops being able to go and get any, and a reservation is not
 * an inference from evidence — it is a fact the customer declared and is already paying for,
 * bounded by a term that ends. Preferring it closes no measurement loop, because the
 * reserved provider is measured by the very traffic the preference sends it.
 */
function pickMinimizer(
  survivors: readonly Provider[],
  objective: DimensionName,
  state: ProviderState,
): Provider {
  const ranked = [...survivors].sort((a, b) => {
    const leftReserved = reservationFor(a, state) !== null;
    const rightReserved = reservationFor(b, state) !== null;
    if (leftReserved !== rightReserved) {
      return leftReserved ? -1 : 1;
    }

    const left = effectiveObserved(objective, a, state);
    const right = effectiveObserved(objective, b, state);

    if (left !== right) {
      if (left === INSUFFICIENT_DATA) return -1;
      if (right === INSUFFICIENT_DATA) return 1;
      if (left < right) return -1;
      if (left > right) return 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // `survivors` is non-empty at every call site; the fallback only satisfies the indexer.
  const best = ranked[0];
  if (best === undefined) {
    throw new Error("no provider available: survivor set was empty");
  }
  return best;
}

/**
 * Rule 5, in order: the objective when one is stated and it actually discriminated (more
 * than one survivor, and their objective values were not all identical); otherwise the
 * active dimension that eliminated the most candidates, ties going to the higher-priority
 * one; otherwise null, meaning nothing bound the choice.
 *
 * The point of the ordering is that `boundBy` should name what an operator would have to
 * change to get a different answer. When the objective did the separating, that is the
 * objective; when a ceiling did the culling, that is the ceiling.
 */
function boundByOf(
  workload: Workload,
  objectiveDiscriminated: boolean,
  breaches: ReadonlyMap<string, readonly RejectionReason[]>,
  active: readonly DimensionName[],
): DimensionName | null {
  if (workload.objective !== "none" && objectiveDiscriminated) {
    return workload.objective;
  }

  /** An unranked dimension loses every tie rather than winning by `indexOf` returning -1. */
  const rank = (dimension: DimensionName): number => {
    const index = workload.priority.indexOf(dimension);
    return index === -1 ? Number.POSITIVE_INFINITY : index;
  };

  let bound: DimensionName | null = null;
  let mostEliminated = 0;
  for (const dimension of active) {
    let eliminated = 0;
    for (const reasons of breaches.values()) {
      if (reasons.some((reason) => reason.dimension === dimension)) {
        eliminated += 1;
      }
    }
    const outranksIncumbent = bound === null || rank(dimension) < rank(bound);
    if (eliminated > mostEliminated || (eliminated === mostEliminated && eliminated > 0 && outranksIncumbent)) {
      mostEliminated = eliminated;
      bound = dimension;
    }
  }

  return bound;
}
