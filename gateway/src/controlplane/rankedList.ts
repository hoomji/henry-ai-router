import { chooseProvider } from "../routing/chooseProvider.js";
import type { DimensionName, Provider, ProviderState } from "../types.js";

/**
 * The ranked list a connector routes on, derived from the routing seam rather than beside
 * it.
 *
 * The whole point of pushing a list instead of answering per request is that the connector
 * calls providers directly and the gateway never sees the traffic. That only stays honest
 * if the list is the *same* policy the in-path choice would have made — otherwise there are
 * two routers, and the second one is the one nobody tests. So this module invents no
 * ordering of its own: it calls `chooseProvider` and reports what it said
 * (docs/adr/0006-routing-authority-stays-gateway-side.md).
 *
 * Pure, like everything it depends on: no clock, no store, no `node:http`. The instant is
 * an argument and the state is a snapshot, so the ordering is provable by calling a
 * function rather than by standing up a server.
 */

/**
 * The synthetic request the seam is asked about.
 *
 * `chooseProvider` ignores the request entirely today, but its signature takes one and that
 * signature is frozen. Naming the constant here rather than threading a real request
 * through is the honest expression of what a ranked list is: a decision made ahead of any
 * particular request.
 */
const SYNTHETIC_REQUEST = {
  method: "POST",
  path: "/v1/chat/completions",
  headers: {},
  body: "",
} as const;

/** One entry of the list, in the wire contract's shape. */
export interface RankedProvider {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly host: string;
  readonly region: string;
  /**
   * The live reservation this entry addresses, or `null` for on-demand capacity.
   *
   * Filled from `state.liveReservations` and from nowhere else. Nothing here may invent a
   * value, because a connector that received a fabricated `addressingModel` would send it to
   * a provider as the model name — and the connector reports `reservationId` straight back
   * on its usage records, so a fabricated one would also corrupt the unaddressed-capacity
   * report that is supposed to catch exactly that class of mistake.
   */
  readonly reservationId: string | null;
  readonly addressingModel: string | null;
}

/** A computed list before a version has been assigned to it. */
export interface RankedListDraft {
  readonly workload: string;
  readonly providers: readonly RankedProvider[];
  /** The dimension the workload is currently missing, so the connector can report it too. */
  readonly unmetDimension: DimensionName | null;
  /** What bound the *first* choice — see `computeRankedList` for why the first one. */
  readonly boundBy: DimensionName | null;
  readonly computedAtMs: number;
}

/**
 * A draft that has been published under a version.
 *
 * Version is deliberately not part of the draft: whether a recomputation deserves a new
 * version depends on whether it differs from what was last published, which is the
 * scheduler's question rather than this module's.
 */
export interface RankedList extends RankedListDraft {
  readonly version: number;
}

export interface RankedListOptions {
  readonly unmetDimension: DimensionName | null;
  readonly computedAtMs: number;
}

/**
 * Rank every candidate for one workload by repeatedly asking who wins.
 *
 * `chooseProvider` returns one winner, not an order, and it must keep doing so — it is the
 * in-path decision function and widening it to return a ranking would change what the data
 * path executes. A total order falls out of it anyway: ask who wins, remove that provider
 * from the candidate set, ask again. The result is exactly the sequence of choices the
 * gateway would have made if each provider ahead of it had been unavailable in turn, which
 * is precisely what a failover order means to the connector.
 *
 * Two consequences worth stating, because both are deliberate:
 *
 * `boundBy` is recorded from the **first** call only. Later calls answer a different
 * question — "who wins once the winner is gone" — and their binding reason describes a
 * counterfactual candidate set. The reason a customer wants explained is why the provider
 * at the top is at the top.
 *
 * A `provider: null` decision **truncates** the list rather than skipping past it. That
 * answer means a hard dimension could not be held by anything left, and the customer's
 * instruction for that case is to fail rather than breach it. Appending the remainder would
 * hand the connector a set of providers the gateway had just refused to use, and the
 * connector — which cannot re-run the policy — would use them.
 */
export function computeRankedList(
  workload: string,
  state: ProviderState,
  options: RankedListOptions,
): RankedListDraft {
  const remaining: Provider[] = [...state.providers];
  const ordered: Provider[] = [];
  let boundBy: DimensionName | null = null;
  let first = true;

  while (remaining.length > 0) {
    // `chooseProvider` throws on an empty candidate set, which the loop guard prevents. The
    // snapshot is rebuilt rather than mutated so the caller's state stays untouched.
    const decision = chooseProvider(SYNTHETIC_REQUEST, { ...state, providers: remaining });
    if (first) {
      boundBy = decision.boundBy;
      first = false;
    }

    const winner = decision.provider;
    if (winner === null) break;

    const index = remaining.findIndex((provider) => provider.id === winner.id);
    // A winner that is not in the set offered would loop forever. It cannot happen today;
    // breaking rather than trusting that is what keeps a future seam change from hanging
    // the push loop.
    if (index === -1) break;
    remaining.splice(index, 1);
    ordered.push(winner);
  }

  return {
    workload,
    providers: ordered.map((provider) => toRankedProvider(provider, state)),
    unmetDimension: options.unmetDimension,
    boundBy,
    computedAtMs: options.computedAtMs,
  };
}

/**
 * Attach the reservation, if this provider addresses one.
 *
 * This is where the whole behavior actually reaches the customer's traffic, and it is three
 * fields on a record the connector already consumes. The match is the same one the routing
 * seam makes — model, host and region against a reservation already filtered to live ones by
 * the snapshot's builder — so the entry the connector calls with `addressingModel` is exactly
 * the entry `chooseProvider` preferred *because* of that reservation. Two matchers that could
 * disagree would put the connector on the provisioned endpoint of a reservation routing had
 * ruled out.
 */
function toRankedProvider(provider: Provider, state: ProviderState): RankedProvider {
  const reservation =
    state.liveReservations?.find(
      (candidate) =>
        candidate.model === provider.model &&
        candidate.host === provider.host &&
        candidate.region === provider.region,
    ) ?? null;

  return {
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    model: provider.model,
    host: provider.host,
    region: provider.region,
    reservationId: reservation?.id ?? null,
    addressingModel: reservation?.addressingModel ?? null,
  };
}

/**
 * The identity of a list's *content*, ignoring when it was computed.
 *
 * The scheduler compares lists to decide whether anything actually changed, and
 * `computedAtMs` moves on every recomputation. Including it would make every tick a change
 * and turn the debounce into a fixed-rate push.
 */
export function listFingerprint(draft: RankedListDraft): string {
  return JSON.stringify({
    workload: draft.workload,
    providers: draft.providers,
    unmetDimension: draft.unmetDimension,
    boundBy: draft.boundBy,
  });
}
