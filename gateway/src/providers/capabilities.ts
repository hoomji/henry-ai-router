import type { CapabilityFloor, DimensionName } from "../types.js";
import { isCeiling } from "../types.js";

/**
 * The capability floor catalogue: the best a `(model, host, region, service_tier)` can
 * plausibly do on a dimension.
 *
 * No provider publishes a latency floor, so most floors here are sourced by measurement
 * rather than by a price sheet (#12, docs/adr/0003-*). That is why every floor carries a
 * provenance tier, its own variance, and an age: a declaration-time rejection rests
 * entirely on this table, and the spec requires a rejection to disclose its basis. A floor
 * nobody can date is a floor nobody can argue with, which is the failure mode this shape
 * exists to prevent.
 *
 * This module is pure. It reads no clock — `observedAtMs` is stated relative to
 * `CATALOGUE_EPOCH_MS` and staleness is decided against a `nowMs` the caller supplies —
 * so a test can place the whole catalogue at any age without faking global time.
 */

/**
 * The instant every `observedAtMs` below is stated against.
 *
 * A literal epoch rather than `Date.now()`: with a clock read in here the catalogue would
 * age differently on every run and no test could pin a rejection's disclosed age.
 */
export const CATALOGUE_EPOCH_MS = Date.UTC(2026, 7, 1);

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The TTL carried by the simulated providers' floors.
 *
 * A real provider's floor is a measurement, and a measurement decays: the fleet changes
 * under it, so past its TTL it can no longer support a rejection. A *simulator's* floor is
 * not a measurement of anything that can change — it is a property of code in this repo,
 * and the stub will be exactly as fast next year as it is today. Letting the sim floors
 * decay in wall-clock time would mean that outside a test pinned to the epoch every
 * declaration-time check abstains, `infeasible_by_declaration` never fires in a real run,
 * and behavior 1's acceptance criteria are unreachable. Hence the decade: the sim entries
 * are exempt from decay, and only the real ones below demonstrate the abstention path.
 */
const SIM_TTL_MS = 3_650 * DAY_MS;

/**
 * Cost floors assume a workload shape, and a rejection that hides its assumption is not
 * disclosing its basis — the customer would have no way to see that a different mix would
 * have been feasible.
 */
const MIXED_TRAFFIC_ASSUMPTION =
  "assuming 1:3 input:output under 200k context, standard tier";
const LONG_CONTEXT_ASSUMPTION =
  "assuming 1:3 input:output above 200k context, standard tier";

export const CAPABILITY_FLOORS: readonly CapabilityFloor[] = [
  // The two providers M2 routes to in simulation. Their floors are measured against the
  // in-repo stub, which is why they are tighter than the hosted ones — and why they do not
  // decay: see SIM_TTL_MS.
  {
    model: "sim-fast",
    host: "sim-a",
    region: "local",
    serviceTier: "standard",
    providerId: "sim-a",
    dimension: "p95_ms",
    value: 120,
    variance: 25,
    provenance: "measured",
    observedAtMs: CATALOGUE_EPOCH_MS - 30 * MINUTE_MS,
    ttlMs: SIM_TTL_MS,
  },
  {
    model: "sim-fast",
    host: "sim-a",
    region: "local",
    serviceTier: "standard",
    providerId: "sim-a",
    dimension: "cost_per_1k_tokens_usd",
    value: 0.004,
    variance: 0.0005,
    provenance: "estimated",
    observedAtMs: CATALOGUE_EPOCH_MS - 2 * HOUR_MS,
    ttlMs: SIM_TTL_MS,
    assumption: MIXED_TRAFFIC_ASSUMPTION,
  },
  {
    model: "sim-fast",
    host: "sim-a",
    region: "local",
    serviceTier: "standard",
    providerId: "sim-a",
    dimension: "success_rate",
    value: 0.995,
    variance: 0.003,
    provenance: "measured",
    observedAtMs: CATALOGUE_EPOCH_MS - 45 * MINUTE_MS,
    ttlMs: SIM_TTL_MS,
  },
  {
    model: "sim-cheap",
    host: "sim-b",
    region: "local",
    serviceTier: "standard",
    providerId: "sim-b",
    dimension: "p95_ms",
    value: 380,
    variance: 60,
    provenance: "measured",
    observedAtMs: CATALOGUE_EPOCH_MS - 30 * MINUTE_MS,
    ttlMs: SIM_TTL_MS,
  },
  {
    model: "sim-cheap",
    host: "sim-b",
    region: "local",
    serviceTier: "standard",
    providerId: "sim-b",
    dimension: "cost_per_1k_tokens_usd",
    value: 0.0008,
    variance: 0.0001,
    provenance: "estimated",
    observedAtMs: CATALOGUE_EPOCH_MS - 2 * HOUR_MS,
    ttlMs: SIM_TTL_MS,
    assumption: MIXED_TRAFFIC_ASSUMPTION,
  },
  {
    model: "sim-cheap",
    host: "sim-b",
    region: "local",
    serviceTier: "standard",
    providerId: "sim-b",
    dimension: "success_rate",
    value: 0.982,
    variance: 0.006,
    provenance: "measured",
    observedAtMs: CATALOGUE_EPOCH_MS - 45 * MINUTE_MS,
    ttlMs: SIM_TTL_MS,
  },

  // Hosted models. The same model served by two hosts gets two rows on purpose: the host
  // is what the floor is a property of, and `allowed_models` lets a customer pin one.
  {
    model: "claude-sonnet-5",
    host: "anthropic",
    region: "us-east-1",
    serviceTier: "standard",
    providerId: "anthropic-us-east-1",
    dimension: "p95_ms",
    value: 1_400,
    variance: 250,
    provenance: "measured",
    observedAtMs: CATALOGUE_EPOCH_MS - 3 * HOUR_MS,
    ttlMs: 12 * HOUR_MS,
  },
  {
    model: "claude-sonnet-5",
    host: "anthropic",
    region: "us-east-1",
    serviceTier: "standard",
    providerId: "anthropic-us-east-1",
    dimension: "cost_per_1k_tokens_usd",
    value: 0.009,
    variance: 0.001,
    provenance: "vendor_published",
    observedAtMs: CATALOGUE_EPOCH_MS - 5 * DAY_MS,
    ttlMs: 30 * DAY_MS,
    assumption: MIXED_TRAFFIC_ASSUMPTION,
  },
  {
    model: "claude-sonnet-5",
    host: "anthropic",
    region: "us-east-1",
    serviceTier: "standard",
    providerId: "anthropic-us-east-1",
    dimension: "success_rate",
    value: 0.998,
    variance: 0.002,
    provenance: "measured",
    observedAtMs: CATALOGUE_EPOCH_MS - 3 * HOUR_MS,
    ttlMs: 12 * HOUR_MS,
  },
  {
    model: "claude-sonnet-5",
    host: "bedrock",
    region: "us-west-2",
    serviceTier: "standard",
    providerId: "bedrock-us-west-2",
    dimension: "p95_ms",
    value: 1_650,
    variance: 300,
    provenance: "measured",
    observedAtMs: CATALOGUE_EPOCH_MS - 4 * HOUR_MS,
    ttlMs: 12 * HOUR_MS,
  },
  {
    model: "claude-sonnet-5",
    host: "bedrock",
    region: "us-west-2",
    serviceTier: "standard",
    providerId: "bedrock-us-west-2",
    dimension: "cost_per_1k_tokens_usd",
    value: 0.0093,
    variance: 0.0012,
    provenance: "vendor_published",
    observedAtMs: CATALOGUE_EPOCH_MS - 6 * DAY_MS,
    ttlMs: 30 * DAY_MS,
    assumption: LONG_CONTEXT_ASSUMPTION,
  },
  {
    model: "claude-haiku-4-5",
    host: "anthropic",
    region: "us-east-1",
    serviceTier: "standard",
    providerId: "anthropic-us-east-1",
    dimension: "p95_ms",
    value: 620,
    variance: 140,
    provenance: "measured",
    observedAtMs: CATALOGUE_EPOCH_MS - 90 * MINUTE_MS,
    ttlMs: 12 * HOUR_MS,
  },
  {
    model: "claude-haiku-4-5",
    host: "anthropic",
    region: "us-east-1",
    serviceTier: "standard",
    providerId: "anthropic-us-east-1",
    dimension: "cost_per_1k_tokens_usd",
    value: 0.0011,
    variance: 0.0002,
    provenance: "vendor_published",
    observedAtMs: CATALOGUE_EPOCH_MS - 5 * DAY_MS,
    ttlMs: 30 * DAY_MS,
    assumption: MIXED_TRAFFIC_ASSUMPTION,
  },
  {
    model: "claude-haiku-4-5",
    host: "anthropic",
    region: "us-east-1",
    serviceTier: "standard",
    providerId: "anthropic-us-east-1",
    dimension: "success_rate",
    value: 0.997,
    variance: 0.002,
    provenance: "measured",
    observedAtMs: CATALOGUE_EPOCH_MS - 90 * MINUTE_MS,
    ttlMs: 12 * HOUR_MS,
  },
];

/**
 * Every floor for one `allowed_models` entry on one dimension.
 *
 * A `null` host means the customer named a bare model and will accept any host serving it,
 * so every host's floor is candidate evidence. A stated host is a pin, and matches exactly:
 * the point of pinning is to exclude the other host's capability from the answer.
 */
export function floorsFor(
  model: string,
  host: string | null,
  dimension: DimensionName,
  catalogue: readonly CapabilityFloor[] = CAPABILITY_FLOORS,
): CapabilityFloor[] {
  return catalogue.filter(
    (floor) =>
      floor.model === model &&
      floor.dimension === dimension &&
      (host === null || floor.host === host),
  );
}

/**
 * Whether a floor is too old to support a rejection.
 *
 * Past its TTL a floor still describes something that was once true, but the spec will not
 * reject a customer's target on evidence that can no longer be trusted — the check abstains
 * instead.
 */
export function isStale(floor: CapabilityFloor, nowMs: number): boolean {
  return nowMs - floor.observedAtMs > floor.ttlMs;
}

/**
 * The most optimistic floor of a set: the one that makes rejection hardest.
 *
 * Optimism is the direction the spec demands — a target is infeasible only when *no*
 * candidate can plausibly meet it, so the candidate that comes closest is the one the
 * target is measured against. Which extreme that is depends on the dimension's direction,
 * so it goes through `isCeiling` rather than hard-coding `<`.
 */
export function bestFloor(
  floors: readonly CapabilityFloor[],
  dimension: DimensionName,
): CapabilityFloor | null {
  let best: CapabilityFloor | null = null;

  for (const floor of floors) {
    if (floor.dimension !== dimension) continue;
    if (best === null) {
      best = floor;
      continue;
    }
    const better = isCeiling(dimension)
      ? floor.value < best.value
      : floor.value > best.value;
    if (better) best = floor;
  }

  return best;
}
