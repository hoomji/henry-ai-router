import { bestFloor, floorsFor } from "../providers/capabilities.js";
import { classifyStatus } from "../routing/stats.js";
import type { Provider, RequestOutcome, Reservation } from "../types.js";
import type { ConnectorUsageRecord } from "../targets/store.js";

/**
 * Turning a connector's usage report into a measurement outcome.
 *
 * **Why this module has to exist.** In the architecture this milestone builds, the gateway
 * is out of the request path: `server.ts` forwards nothing in normal operation, so the
 * `RequestOutcome`s it feeds the rolling windows stop arriving. Everything downstream of
 * those windows — the measured `ProviderState`, the ranked list's ordering, the two-window
 * `unmet` machine, and every dimension on the status resource — is therefore fed by exactly
 * one source once a connector is installed: these reports. Without this translation the
 * control plane would persist usage for billing and still believe it had never measured a
 * provider, which is the failure mode where target-state routing looks implemented and is
 * inert.
 *
 * It is pure for the same reason `chooseProvider` is: no clock, no I/O, no configuration
 * read. Every fact it needs — which providers exist, which reservations are live — arrives
 * as an argument, so the mapping can be asserted directly in a test rather than inferred
 * from what the windows later reported.
 */

/** What the mapping needs to know about the world, resolved by the caller. */
export interface UsageOutcomeContext {
  /** The configured catalogue, used to recover a provider's host, region, and tier. */
  readonly providers: readonly Provider[];
  /** Reservations live at the moment of the report; the caller resolved the term. */
  readonly liveReservations: readonly Reservation[];
}

/**
 * The unit rate to attribute to one reported call.
 *
 * `cost_per_1k_tokens_usd` is a *rate*, not a total, so the quantity measurement wants is
 * the price the customer was charged per thousand tokens — not something derived from the
 * token counts in the record. This mirrors what the in-path tracer did when it read the
 * simulated rate off a response header, and what `chooseProvider` does when it prices a
 * candidate.
 *
 * The order is the one the routing seam already uses, and it must stay the same order: a
 * reservation the call actually addressed prices at the customer's own effective rate,
 * because under a reservation the customer is not paying the public rate and reporting that
 * they are would make the cost dimension describe a bill nobody receives. Otherwise the
 * catalogue's public rate for that provider applies.
 *
 * `null` means the rate is genuinely unknown — an unrecognized provider with no catalogue
 * entry. The caller drops such a record rather than attributing `0`, because a zero rate is
 * indistinguishable from free capacity and would drag a workload's measured cost toward a
 * number no provider ever charged.
 */
function rateFor(
  record: ConnectorUsageRecord,
  provider: Provider | null,
  context: UsageOutcomeContext,
): number | null {
  if (record.reservationId !== null) {
    const reservation = context.liveReservations.find(
      (candidate) => candidate.id === record.reservationId,
    );
    if (reservation !== undefined) return reservation.effectiveRatePer1kTokensUsd;
  }

  const model = provider?.model ?? record.model;
  const host = provider?.host ?? null;
  const floor = bestFloor(floorsFor(model, host, "cost_per_1k_tokens_usd"), "cost_per_1k_tokens_usd");
  return floor?.value ?? null;
}

/**
 * One reported call as measurement sees it, or `null` when it must not be counted.
 *
 * Two distinct reasons produce `null`, and conflating them would hide a real problem. A
 * *malformed* call is excluded on purpose — the customer's own bad request is not provider
 * risk, and `classifyStatus` owns that judgement for both callers. An *unpriceable* call is
 * excluded because we cannot honestly say what it cost; that one is worth logging, because
 * it means a connector is reporting a provider this gateway does not know about.
 */
export function usageOutcome(
  record: ConnectorUsageRecord,
  context: UsageOutcomeContext,
): { readonly outcome: RequestOutcome } | { readonly dropped: "malformed" | "unpriceable" } {
  const { success, malformed } = classifyStatus(record.statusCode);
  if (malformed) return { dropped: "malformed" };

  const provider =
    context.providers.find((candidate) => candidate.id === record.providerId) ?? null;
  const rate = rateFor(record, provider, context);
  if (rate === null) return { dropped: "unpriceable" };

  return {
    outcome: {
      workload: record.workload,
      providerId: record.providerId,
      // Provider-attributable latency, measured by the connector at the call site. That is
      // the same quantity the in-path tracer measured — time spent waiting on the provider,
      // and the only portion a routing decision can move.
      latencyMs: record.latencyMs,
      costPer1kTokensUsd: rate,
      success,
      malformed: false,
      atMs: record.atMs,
    },
  };
}
