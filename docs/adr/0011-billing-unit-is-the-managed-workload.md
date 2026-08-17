# The billing unit is the managed workload, not the connector process

Status: proposed (2026-08-17)

[`pricing-strategy.md`](../product-specs/pricing-strategy.md) proposes connector-count pricing
and then records, in its own Constraints and its own open-decisions table, that it does not know
what a "connector" is for billing purposes — whether the billing unit should be defined
identically to the architecture's *connector* or as a distinct unit.
[#22](https://github.com/hoomji/henry-ai-router/issues/22) escalates that from an open question
to a contract-dispute risk, and it is right to: the two candidate definitions differ by an
order of magnitude for the same customer.

An architectural *connector* is a process. A customer running one service across twelve
autoscaled replicas runs twelve connectors, each holding its own SSE stream, and would be
billed twelve times for one integration. Scale to zero overnight and they run none. Neither
number describes anything the customer recognises as what they bought, and both are numbers our
own infrastructure decides rather than they do.

The decision: **the billing unit is the managed workload** — the customer-named class of
traffic that already carries a *target*, already appears at
`GET /v1/workloads/{name}/status`, and is already the unit the product's whole policy surface
is organised around. Connector processes are counted for capacity planning and shown to the
customer for diagnosis; they are never a line on an invoice. The word *connector* is retired
from pricing language entirely, because a term that means a process in the architecture and
something else on the invoice is a defect waiting for a renewal conversation.

The rest of the pricing draft is untouched by this. Whether the rate is per workload, a
percentage of spend, or both remains open under #22; this ADR settles only what is being
counted.

## Considered options

**Count connector processes.** Rejected. It bills a customer for their own deployment topology,
punishes horizontal scaling and blue-green deploys, rewards running fewer, larger processes, and
produces an invoice that moves when nothing about the customer's use of the product changed. It
also makes our revenue a function of their autoscaler, which is unforecastable for both sides.

**Count seats.** Rejected, and worth naming because every competitor surveyed has a seat
component somewhere. This product has no per-user surface at all: a workload's target is set by
whoever holds the credential to write the target document, and nothing in the system knows how
many humans a customer has. Billing seats would mean building a user model to bill it.

**Count tokens or requests.** Rejected as the primary unit, on the ground the pricing spec
already argues: token volume is not this architecture's cost driver, because we do not carry the
tokens. Charging for volume we never touch is the "proxy markup story" the positioning
explicitly refuses, and it invites the comparison against 5% proxy competitors on their terms
rather than ours. It stays available as the optional percentage-of-spend path for customers who
prefer that shape, which is a billing-shape preference and not a claim about our cost.

**Count managed workloads.** Chosen. It is a unit the customer names, controls, and already
sees; it maps one-to-one onto the thing the product actually does for them, which is hold a
target for a class of traffic; and it is stable under deployment changes. It is also the unit
every existing surface is already keyed by, so metering it needs no new concept — the status
resource is the meter's natural source.

## Consequences

**Workload count and cost are only loosely coupled, and that is accepted.** Our real cost driver
is held-open SSE connections, which tracks connector processes, not workloads. Billing a unit
that is not the cost driver means a customer with one workload across two hundred replicas is
underpriced relative to a customer with twenty workloads on one process each. The trade is
deliberate: a unit the customer understands and can forecast, at the price of margin variance we
absorb. It only stays acceptable while the SSE cost per connection is small, and that number is
[undocumented](../../ARCHITECTURE.md) — which makes sizing it a precondition on any rate card,
exactly as #22 says.

**A customer can game it, cheaply and visibly.** Collapsing twenty workloads into one named
workload reduces the bill and degrades the product for them: one target across traffic classes
that want opposite trade-offs is precisely the failure the per-workload design exists to
prevent, and the spec says so in *What a customer can target*. The incentive is
self-correcting, and the status resource shows it happening, so it is monitored rather than
policed.

**The pricing spec needs edits, not a rewrite.** Its Required behavior 1 and 3, its acceptance
criteria, and the free-allowance row all say "connector" where they now mean "workload"; its
Constraints paragraph about keeping the billing unit consistent with the architecture is
resolved by this ADR and should cite it. The free-tier count proposed as 5 connectors is a
different quantity as 5 workloads, and is one of the numbers #22 has to ground anyway.

**Connector count still has to be metered.** For capacity planning, for the per-connection cost
model, and because a customer diagnosing "why did my traffic go to the fallback provider?" needs
to see their own processes and their ack state — which `npm --prefix gateway run inspect`
already reports and a hosted product will have to expose. Not billing something is not a reason
not to measure it.

## Residual assumption

This assumes customers organise their traffic into workloads at a granularity that produces a
sane invoice — a handful per company, not one per endpoint and not one for everything. Nothing
enforces that and nothing has observed it, because no customer has ever declared a workload. If
real usage clusters at one workload per company, the unit carries no price signal at all and the
rate card collapses into a flat fee; if it clusters at hundreds, the unit is too fine and reads
as a per-endpoint tax. Phase 0 of
[#18](https://github.com/hoomji/henry-ai-router/issues/18) produces the first real datum, and
one design partner's workload count is worth more than any further reasoning here.
