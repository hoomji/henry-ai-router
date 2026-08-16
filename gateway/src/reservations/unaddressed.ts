import { reservationIsLive } from "../types.js";
import type { Provider, Reservation } from "../types.js";
import type { ConnectorUsageRecord } from "../targets/store.js";

/**
 * Unaddressed capacity: reserved throughput the customer paid for and their traffic walked
 * past.
 *
 * Computed from the connector's own usage reports and never from the provider. Both reasons
 * are settled in the specification: Azure publishes a utilization metric but Azure Monitor
 * lags between thirty seconds and fifteen minutes against a five-minute measurement window,
 * and Bedrock publishes no utilization figure at all. A read-only cloud credential could
 * corroborate this later; requiring one would be a heavier install than the connector.
 *
 * Pure: the instant is an argument and the usage rows are handed in, so the report is
 * provable by calling a function.
 *
 * The report's value is not the gap — it is the *cause*. A customer told "you used 4% of
 * what you bought" learns nothing they could act on; a customer told "9,214 calls asked for
 * `claude-sonnet-5` when reaching this capacity requires
 * `arn:aws:bedrock:...:provisioned-model/abc`" knows which line of their code to change.
 * The connector is the only component that can see this, because it sits at the call site.
 */

/**
 * Why addressable traffic did not address the reservation.
 *
 * A closed vocabulary rather than free text, because these are acted on differently: the
 * first is a code change at the call site, the second is a declaration that does not match
 * the fleet, the third is nothing to do at all.
 */
export type UnaddressedCause =
  | "call_site_used_foundation_model"
  | "term_not_live"
  | "no_addressable_traffic"
  | "unknown";

/** One reservation's utilization over the reporting window, and why it is what it is. */
export interface UnaddressedReport {
  readonly reservationId: string;
  readonly host: string;
  readonly model: string;
  readonly region: string;
  readonly addressingModel: string;
  /** True when `nowMs` falls inside the term; a dormant term is not a utilization failure. */
  readonly live: boolean;
  /** Calls that could have addressed this reservation: right model, host, region, in term. */
  readonly addressableRequests: number;
  /** Of those, the ones the connector reported against this reservation identifier. */
  readonly addressedRequests: number;
  /** Tokens that went to on-demand capacity while reserved capacity sat paid for. */
  readonly unaddressedTokens: number;
  /** `0` when nothing was addressable, so an idle term never reads as 100% utilized. */
  readonly addressedShare: number;
  readonly cause: UnaddressedCause;
  /** The cause in a sentence, naming the identifiers involved. Never null. */
  readonly detail: string;
}

/**
 * Whether a usage record could have addressed this reservation.
 *
 * Region and host both matter and neither is cosmetic: reserved capacity is bought in one
 * region on one host, and a call served from another is not a call that *chose* to skip it.
 * The host comes from the provider catalogue rather than from the record, because the wire
 * contract's `UsageRecord` carries the provider id and the gateway is what knows what that
 * provider is.
 */
function addressable(
  record: ConnectorUsageRecord,
  reservation: Reservation,
  hostOf: ReadonlyMap<string, string>,
): boolean {
  if (record.atMs < reservation.termStartMs || record.atMs >= reservation.termEndMs) return false;
  if (record.region !== reservation.region) return false;
  if (hostOf.get(record.providerId) !== reservation.host) return false;
  // Either identifier counts as traffic for this model: the foundation name is the call that
  // missed the reservation, the addressing string is the call that hit it. Excluding the
  // latter would make a fully-utilized reservation look like it had no addressable traffic.
  return record.model === reservation.model || record.model === reservation.addressingModel;
}

export function unaddressedCapacity(
  reservations: readonly Reservation[],
  usage: readonly ConnectorUsageRecord[],
  providers: readonly Provider[],
  nowMs: number,
): UnaddressedReport[] {
  const hostOf = new Map(providers.map((provider) => [provider.id, provider.host]));

  return reservations.map((reservation) => {
    const live = reservationIsLive(reservation, nowMs);
    const candidates = usage.filter((record) => addressable(record, reservation, hostOf));
    const addressed = candidates.filter((record) => record.reservationId === reservation.id);
    const missed = candidates.filter((record) => record.reservationId !== reservation.id);
    const unaddressedTokens = missed.reduce(
      (sum, record) => sum + record.promptTokens + record.completionTokens,
      0,
    );

    return {
      reservationId: reservation.id,
      host: reservation.host,
      model: reservation.model,
      region: reservation.region,
      addressingModel: reservation.addressingModel,
      live,
      addressableRequests: candidates.length,
      addressedRequests: addressed.length,
      unaddressedTokens,
      addressedShare: candidates.length === 0 ? 0 : addressed.length / candidates.length,
      ...diagnose(reservation, live, candidates.length, missed),
    };
  });
}

/**
 * Name the cause, or say plainly that it is not knowable.
 *
 * The ordering matters. A term that is not live is checked first because every other
 * diagnosis would be reporting a defect in traffic that had no reservation to address in the
 * first place. `unknown` is a real outcome and is not padded into something that sounds like
 * an explanation: the whole promise of this report is that a named cause can be trusted.
 */
function diagnose(
  reservation: Reservation,
  live: boolean,
  addressableRequests: number,
  missed: readonly ConnectorUsageRecord[],
): { cause: UnaddressedCause; detail: string } {
  if (!live) {
    return {
      cause: "term_not_live",
      detail:
        `reservation ${reservation.id} is outside its term ` +
        `(${reservation.termStartMs}..${reservation.termEndMs}), so no traffic can address it`,
    };
  }

  if (addressableRequests === 0) {
    return {
      cause: "no_addressable_traffic",
      detail:
        `no reported call in the window asked for ${reservation.model} on ` +
        `${reservation.host}/${reservation.region}, so nothing could have addressed ` +
        `reservation ${reservation.id}`,
    };
  }

  if (missed.length === 0) {
    return {
      cause: "no_addressable_traffic",
      detail:
        `every addressable call in the window reached reservation ${reservation.id} through ` +
        `${reservation.addressingModel}`,
    };
  }

  // The common case, and the one the connector can see directly: the call site asked for the
  // foundation model. The provider answers it — on demand, at the public rate — so nothing
  // fails and nothing else in the stack would ever notice.
  const byFoundationModel = missed.filter((record) => record.model === reservation.model);
  if (byFoundationModel.length === missed.length) {
    return {
      cause: "call_site_used_foundation_model",
      detail:
        `${missed.length} of ${addressableRequests} addressable calls passed the foundation ` +
        `model identifier "${reservation.model}" instead of the provisioned identifier ` +
        `"${reservation.addressingModel}", so they were served on demand while reservation ` +
        `${reservation.id} stayed paid for and idle`,
    };
  }

  return {
    cause: "unknown",
    detail:
      `${missed.length} of ${addressableRequests} addressable calls did not report ` +
      `reservation ${reservation.id}, and their reported model identifiers do not agree on ` +
      `a single cause`,
  };
}
