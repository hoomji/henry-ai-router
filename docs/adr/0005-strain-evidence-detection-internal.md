# Strain evidence is detection-internal; disclosure stays banded

Status: accepted (2026-08-15)

Resolving incident detection ([#9](https://github.com/hoomji/henry-ai-router/issues/9))
required deciding what data the detector may read. The aggregation contract from
[#5](https://github.com/hoomji/henry-ai-router/issues/5) publishes provider strain in
5-minute buckets one full bucket late, quantized into bands, and suppressed below a cohort
of ten. Read as a constraint on the *detector*, that contract puts strain detection up to
ten minutes behind the storm it is detecting — against an interception mechanism
([#4](https://github.com/hoomji/henry-ai-router/issues/4)) whose entire value is
sub-second insertion.

We split the contract in two. Detection runs against the internal aggregate at fine
granularity. The k-threshold, banding, and publication delay bind **disclosure** — the
published feed and anything shown to a customer — and nothing else. #5's own reasoning
already points here: it rejects local differential privacy precisely because the gateway is
a trusted aggregator, which is a statement about what the aggregator may see.

Two structures follow from that split rather than from any separate decision, and are
recorded here because they are the split's consequences:

- **Provider strain and the interception window are different nouns.** Strain is global,
  aggregated, and is evidence. A window is per customer and workload, is an action, and is
  the thing with auditable edges. The word *incident* named both at once and is retired.
- **A window may open on cohort evidence alone**, before the customer's own traffic shows
  anything — this is what behavior 3 promises — and is then marked `anticipatory` rather
  than `observed`.

## Considered options

**Detect from the published feed.** One aggregate, one contract, nothing to keep straight,
and no way for detection to see something disclosure cannot. Rejected on latency: a
detector reading a feed published one bucket late declares between five and ten minutes
after onset, which is slower than the customer noticing. It would leave the interception
mechanism's sub-second insertion measuring the gap between two of our own subsystems.

**Give the disclosed record full evidentiary detail.** Let a window's report name the
cohort, its size, and the contributing signals in full, so the customer can check the
declaration themselves. Rejected because it re-identifies: cohort composition around a
strained provider at a known minute is exactly the traffic pattern #5 exists to keep one
customer from inferring about another. A customer's ability to audit their own
interception cannot be paid for with another customer's exposure.

**Split detection from disclosure.** Chosen. The detector reads internally; the customer
sees the evidence class, the corroborating signal types, the banded deviation, and the
providers involved, with cohort size and composition withheld.

## Consequences

The customer cannot fully reconstruct why an anticipatory window opened. They receive its
class, its corroboration, and its banded magnitude, and that is strictly less than what an
`observed` window gives them, where their own traffic is the evidence. This is the honest
cost and the specification states it rather than smoothing it: for anticipatory windows the
customer is asked to accept a disclosure that is real but partial.

The asymmetry is bounded by three things decided alongside it. An anticipatory window
requires corroboration across at least two signal types or two disjoint cohorts before it
may open, so a single noisy source cannot produce one. Interception carries no charge
([ADR 0004](0004-incidents-included-not-surcharged.md)), so a wrong window costs the
customer nothing but a routing change. And the per-request tag on every intercepted
response lands in the customer's own logs, so the *extent* of a window is independently
checkable by them even where its *cause* is not.

Two aggregates now exist where a reader of #5 alone would expect one, and the internal one
has no published contract disciplining it. That is a maintenance hazard: it would be easy
to let a customer-facing surface read from the internal aggregate by accident, which is a
privacy failure that no test currently catches. The specification's disclosure limits are
the only thing standing between those two paths, and they deserve mechanical enforcement
before this behavior is built.

## Residual assumption

This assumes fine-grained internal aggregation is actually enough faster to matter — that
strain is detectable within a 30-second window at all, rather than needing several minutes
of data to separate from noise. If real provider degradation only becomes statistically
distinguishable over a five-minute span, the split buys nothing, and the correct
correction is to collapse it rather than to keep two aggregates for a latency advantage
that does not exist.
