# The capability catalogue is provenance-tiered, biased optimistic, and may abstain

Status: accepted (2026-08-15)

ADR [`0001`](0001-declaration-time-vs-observed-infeasibility.md) accepted a declared
capability floor per allowed model as the cost of having a declaration-time infeasibility
state at all, and named it a catalogue we "must maintain and keep honest." The gateway
design document went further and called it the weakest assumption in the design. Neither
said where a floor comes from, how often it is refreshed, which direction it should err,
or what happens to a customer when it is wrong.

Research into what providers actually publish
([#11](https://github.com/hoomji/henry-ai-router/issues/11),
[`../references/2026-08-15-provider-capability-floors.md`](../references/2026-08-15-provider-capability-floors.md))
established two facts that make the original assumption untenable rather than merely
weak:

- **No provider publishes a latency floor, in any form** — no docs table, no SLA number,
  no status-page field. Availability is published only per region and per account, never
  per model. Only cost is published, and never as a single per-1k rate.
- **A floor keyed per model is wrong in both directions.** Claude Sonnet 4.5 on
  2026-08-15 measured p50 744 ms on `vertexAnthropic`, 795 ms on `anthropic`, and 1383 ms
  on `bedrock` — an 86% spread on p50 and 165% on p95, purely by host, same model, same
  day. A target of `p95_ms: 900` is feasible on two of those hosts and infeasible on the
  third.

We therefore model a **capability floor** as an entry keyed
`(model, host, region, service_tier)` carrying a value, a **provenance** tier, a variance
where one exists, and an age. Floors resolve through a fixed precedence of tiers, expire
on a per-tier TTL, are biased toward accepting the customer's target, and may **abstain**
entirely rather than reject on a number we no longer trust.

## Considered options

**Hand-declared, refreshed on a review cadence.** The status quo assumption. Rejected
because a hand-maintained catalogue with a calendar trigger and a single accountable human
is wrong within a quarter and gives no signal that it has gone wrong — and because the
input it would be maintained *from* does not exist for latency at all. There is nothing to
read.

**Measured from our own traffic only.** Honest, and the only tier with ground truth.
Rejected as the sole source because it is circular: we can only measure models we already
route to, and declaration-time feasibility must answer for a model in `allowed_models`
that has never received a request. Measurement-only means the check abstains on exactly
the cold-start case it exists to serve.

**Published-only, from provider documentation.** Rejected on the evidence above. It would
produce a catalogue that answers confidently on cost and cannot answer at all on latency
or availability, while presenting both as the same kind of fact.

**Provenance-tiered, with a TTL and an abstention.** Chosen. Every floor names its own
source and age, so a floor is a claim with a warrant attached rather than a bare number.
Precedence, highest trust first:

| Tier | Source | TTL | Answers |
|---|---|---|---|
| `measured` | Our own traffic, from `routing/stats.ts` | Rolls continuously | Everything, for models we already route to |
| `third_party` | Vercel AI Gateway's unauthenticated endpoints API: live p50/p95, throughput, uptime per (model, host) | Polled daily, expires at 7 days | The cold-start case — the only public source in existence that answers latency per model |
| `published` | Provider rate cards | 30 days | Cost only |
| `declared` | Hand-entered, with a written justification | 90 days | Last resort |

An expired floor is not used: it **demotes** to the next tier down. When every tier for a
key has expired, feasibility **abstains** and the write is accepted.

## Consequences

This is hard to reverse because it changes what `infeasible_by_declaration` *means*, and
three other decisions were made to fit it.

**The declaration-time guarantee is narrowed from "can" to "plausibly can."** A target is
rejected only when it fails against the *most optimistic* candidate floor by a margin
exceeding that floor's own observed variance, derived from the published p50/p95 spread
where one exists. This is a deliberate choice of which error to make, and the two errors
are not symmetric:

- A **too-optimistic** floor accepts a target that turns out to be impossible. The
  customer learns via `unmet` two windows later — visible, recoverable, and precisely what
  the second state exists for.
- A **too-pessimistic** floor rejects a target the customer could actually have had. This
  produces no traffic, and therefore no measurement, and therefore no evidence that we
  were wrong. It is a silent loss with no feedback path at any timescale.

We prefer the recoverable error. A floor with no variance behind it — a bare `declared` or
`published` value — may inform the best-achievable value reported in a rejection but may
never be the *basis* for one. ADR 0001 is amended, not superseded: its two-state core
survives, only the strength of the declaration-time claim moves.

**The honest consequence at M2, stated rather than discovered.** With no measured floors
and no variance on the cold-start tier, **latency targets are effectively never rejected
at write time; cost targets are.** The check earns its power as measurement accumulates.
Shipping M2 while implying otherwise would be the dishonest version of this feature.

**The catalogue is a committed artifact, not a runtime dependency.** The three unmeasured
tiers ship as a generated file refreshed by a scheduled job that opens a pull request; the
gateway reads a local file. Polling a third party from the gateway itself was rejected —
it would put a new outbound failure surface next to a customer's write path, and a Vercel
schema change should break a job, not a `PUT`. The artifact also makes every floor change
a dated, reviewable diff, which is what converts "who is accountable when a floor is
stale" from a memory problem into a visible one. The `measured` tier stays in process; it
is already what the routing stats produce.

**A wrong floor gets a name, but not a third state.** A correction never invalidates a
live target document — nothing but a customer write may change the validity of the
document specified as their single source of truth, and a background job that retroactively
breaks a live configuration because *our* data changed is a worse failure than the stale
floor it fixes. Instead: each write commits a **decision receipt** (the floor values and
provenance the check ran against, keyed by document version) in the same transaction as the
document; a correction flags the status resource; and the notification fires only for the
sharp case — a workload already `unmet` on a dimension whose corrected floor now exceeds
its target. That case is the one path on which the specification's promise (infeasibility
is reported, never silently best-effort) can fail without anyone noticing, because it
presents to the customer as ordinary provider degradation.

A third infeasibility state was considered and rejected. ADR 0001's two-state vocabulary
is load-bearing across three contracts — the status schema, the notification trigger, and
the routing seam's return type — and a third state pays that cost again to express
something that is not a property of the customer's workload but of our own data quality.

The cost accepted in exchange: a continuous measurement obligation per
`(model, host, region, service_tier)` rather than a quarterly documentation scrape; a
scheduled job and a generated artifact the repository did not previously have; a receipts
table alongside the target document; an owner accountable for an *abstention rate* rather
than for a review cadence; and a declaration-time check that is honestly weak on latency
until traffic exists.

## Residual assumption

One thing this decision does not fix, and which remains the design's weakest point: a
cold-start floor is **trusted, not verified**. We have no way to validate a `third_party`
floor against ground truth for a model we never route to — the only thing that would
validate it is the traffic whose feasibility we are trying to decide.
