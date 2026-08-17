# Provider risk management gateway

- State: `Accepted` — partially delivered; see [Delivery evidence](#delivery-evidence)
- Owner: henry.tran@uniblock.dev
- Reviewed: 2026-08-16
- Sources: idea record formerly at `IDEA.md` (five random-stimulus ideas and their
  meta-pattern, reproduced below so this specification stands alone)
- Supersedes: none

## User and problem

Teams that build on hosted AI model providers treat those providers as reliable, known
counterparties — but providers rate-limit, degrade, deprecate models, and go down without
warning. Existing AI routers sell routing rules, a unified API schema, and dashboards;
none of them sell **provider risk management** as a product. When a provider fails, each
customer discovers it alone, reacts after the failure, and pays an always-on middleman tax
for the privilege.

The user is an engineering team running production traffic against one or more AI
providers who needs provider failure, degradation, and waste handled for them — before it
costs them an outage or an invoice surprise.

## Outcome

A customer can state what they need from their AI traffic (reliability and cost targets)
and the gateway absorbs provider risk on their behalf: it anticipates provider strain,
intervenes only when needed, keeps behavior consistent across models, and stops them
paying their provider for reserved capacity nobody is using. The observable difference is
fewer provider-caused failures reaching the customer, and a bill that tracks risk
absorbed rather than middleman presence.

## Required behavior

The five candidate behaviors below originate from the idea record. The specification
records what each must do; the order in which they are built, and which are deferred, is
settled in [Behavior sequence and deferrals](#behavior-sequence-and-deferrals).

1. **Target-state routing.** The customer states an outcome instead of a routing rule;
   the gateway continuously adjusts the provider mix to hold that outcome proactively
   rather than reacting after a breach. This behavior is specified in full in
   [Target-state routing in detail](#target-state-routing-in-detail) below.
2. **Strain-triggered interception.** The gateway is absent from the request path in
   normal operation and takes the data path only while an *interception window* is open,
   opened by evidence of *provider strain*. Both edges of that window are auditable.
   Interception carries **no incremental charge**: what the customer pays does not depend
   on whether a window was opened (see [Pricing model](#pricing-model)). This behavior is
   specified in full in [Strain-triggered interception in
   detail](#strain-triggered-interception-in-detail) below.
3. **Collective fatigue-aware routing.** Every connected customer contributes
   provider-observed evidence — status codes and latencies — into a global *cell*, and the
   gateway routes on the resulting *provider strain*, so a customer's traffic shifts away
   from a strained provider before that customer receives a 429. Strain is never fed to a
   customer; it changes their routing. This behavior is specified in full in [Collective
   strain signals in detail](#collective-strain-signals-in-detail) below.
4. **Reservation-aware routing.** A customer's declared *reservation* — provider capacity
   they have already paid for, such as Bedrock Provisioned Throughput or Azure OpenAI
   PTU — is surfaced when traffic is not addressing it, and eligible traffic is routed
   onto it ahead of on-demand capacity. The gateway never holds the reservation. Formerly
   "usage-decay pricing"; it is not a pricing behavior (see
   [Pricing model](#pricing-model)).
5. **Semantic-fidelity prompt translation.** When a request is routed to a different
   model than the one it was written for, the gateway adapts the prompt so the intended
   behavior is preserved — not just the API shape — for example restructuring a system
   prompt for a model weaker at instruction following.

## Target-state routing in detail

This section specifies required behavior 1. Terms in *italics* on first use are defined
in [`CONTEXT.md`](../../CONTEXT.md).

### What a customer can target

A *target* is stated per *workload*, not per customer and not per model. A workload is a
customer-named class of traffic — an interactive chat path and a batch summarization path
want opposite trade-offs, and a single customer-wide target cannot serve both. Every
customer has a workload named `default`; requests that name no workload fall to it.

A target consists of:

- **Dimensions.** Zero or more ceilings or floors drawn from a closed vocabulary of
  three: `p95_ms`, `cost_per_1k_tokens_usd`, and `success_rate`. The vocabulary is closed
  deliberately — every dimension the gateway offers is one it must be able to measure,
  hold, and diagnose.
- **An objective.** Exactly one dimension named as the quantity to minimize (or `none`,
  meaning hold the cheapest satisfying mix). Ceilings alone leave the target
  underdetermined: any mix inside the box satisfies them equally, and the gateway's choice
  among them becomes unexplainable to the customer.
- **A priority order** over the stated dimensions, deciding which ceiling yields first
  when no mix satisfies all of them. If undeclared, the order is the reverse of the order
  in which dimensions were declared.
- **At most one hard dimension**, meaning the gateway must fail the request rather than
  breach it. If undeclared, no dimension is hard.
- **`allowed_models`** — a required, non-empty list of models the gateway may route to.
  It is not a quality target and carries no quality scale; it is the customer's explicit
  blast radius. Requiring it is what makes declaration-time feasibility computable at
  all, because it bounds the set of candidates. An entry is a bare model name, meaning any
  host the gateway can reach for that model, and may optionally be qualified with a host
  (`claude-sonnet-4.5@bedrock`) to pin one. The distinction is not cosmetic: the same model
  served by different hosts measured an 86% spread in p50 latency on a single day
  ([#11](https://github.com/hoomji/henry-ai-router/issues/11)), so a bare entry and a
  pinned entry can differ on whether a target is achievable at all.

Model quality is not a targetable dimension. Scoring model quality would make this
product a benchmarking service, which the non-goals exclude; `allowed_models` gives the
customer the control they actually want without that.

One rule governs what may ever join the vocabulary: **a targetable dimension is a property
of a provider that the customer could in principle verify, not a property of the customer
base.** A dimension is checked at declaration time against a *capability floor* keyed per
`(model, host, region, service_tier)`, so a quantity with no such floor has nothing to be
checked against and would abstain permanently. And a cohort-derived quantity reaches a
customer only as a *band* above twenty contributors (see [What a customer is told, and what
is withheld](#what-a-customer-is-told-and-what-is-withheld)), which is not a value anyone can
hold the gateway to. Rate-limit headroom is the case that produced this rule and the case it
excludes.

Listing several models in `allowed_models` is the customer's assertion that those models
are **interchangeable for that workload**. The gateway routes freely within the list and
does not adapt a prompt when it moves a request from one listed model to another; prompt
translation (behavior 5) exists for cross-model failover during an *interception window*,
not for ordinary routing inside a blast radius the customer drew. A customer who does not
want a model's output removes it from the list.

### How each dimension is measured

| Dimension | Definition | Window |
|---|---|---|
| `p95_ms` | Provider-attributable latency: time to last byte from the upstream, excluding the customer's own network hop. Only this portion is movable by a routing decision. | Trailing 5 minutes **or** 200 requests, whichever spans longer |
| `cost_per_1k_tokens_usd` | Unit rate for the mix actually served | Same window |
| `success_rate` | Share of requests that received a usable response **after** all gateway-internal retries and failovers | Same window |

A provider 429, 5xx, or timeout that the gateway successfully re-routed is **not** counted
as a failure — absorbing it is the product being sold. Requests rejected as malformed
(customer 4xx) are excluded entirely; they are not provider risk.

Below the sample floor a workload has no measured value for a dimension. The gateway
reports `insufficient_data` for it and must not report a percentile computed from a
handful of requests.

### How a customer states a target

Targets live in a single versioned *target document* per customer. That document is the
only source of truth. A management API and a dashboard are two views onto it: the
dashboard may propose a change, but a change takes effect only by writing the document.
Reads return the document's version; writes must supply the version they replace, and a
mismatch is rejected — without that, "one source of truth" is untrue the moment a
dashboard edit and a configuration deploy overlap.

A request names its workload by an `x-gateway-workload` header, the only mechanism every
provider SDK can set without leaving the SDK. A customer who cannot modify call sites may
instead bind a workload to an API key. The workload name must not be carried in the
request path, because path-based routing breaks the base-URL substitution that behavior 2
depends on.

### When a target cannot be met

Infeasibility is two distinct states with different truth conditions, different detection
latencies, and different meanings to the customer. They must never be collapsed into one.

**`infeasible_by_declaration`** — no allowed provider *plausibly can* satisfy the target,
knowable before any traffic flows. Checked synchronously when the target document is
written; the write is rejected. The customer cannot deploy an impossible target.

The check runs against a **capability floor** per `(model, host, region, service_tier)`,
and the strength of the word *plausibly* is deliberate. No provider publishes a latency
floor in any form, so floors are sourced by measurement and carry a **provenance** tier and
an age ([#12](https://github.com/hoomji/henry-ai-router/issues/12), ADR
[`0003`](../adr/0003-provenance-tiered-capability-catalogue.md)). Three consequences are
customer-visible and belong in this specification rather than in the design:

- **Rejection is biased against itself.** A target is rejected only when it fails the most
  optimistic candidate floor by more than that floor's own variance. A too-optimistic floor
  costs the customer a wait until `unmet`; a too-pessimistic one costs them a capability
  they could have had, silently and with no signal, since a rejected target produces no
  traffic to prove us wrong. When no floor for a candidate can be trusted — every source for
  it has gone stale — the check **abstains and the write is accepted**. The gateway does not
  reject a customer's target on the strength of a number it no longer stands behind.
- **A rejection must disclose its own basis.** In addition to the dimension, the requested
  value, the best achievable value, and the provider achieving it, the report names the
  floor's source and its age, and states any workload shape it assumed for a cost target
  ("assuming 1:3 input:output under 200k context, standard tier"). The customer's only
  recourse against a wrong floor is to dispute it, and a bare number is not disputable.
- **A corrected floor never invalidates a live target document.** A target already accepted
  stays accepted and stays in force; only a customer write changes what the document says.
  When a correction means a target would no longer be accepted, the status resource says so
  and the customer decides whether to rewrite.

**`unmet`** — no mix of allowed providers *has* held the target over the measurement
window. A runtime state, entered after two consecutive full windows in which the target
was missed, and left after two consecutive full windows in which it was held. Entry and
exit are deliberately symmetric: a state that toggles every few minutes gets muted, and a
muted alert defeats the reporting guarantee this section exists to make.

Both reports are diagnoses, not alarms. Each must name the dimension at fault, the
targeted value, and the binding reason:

- `infeasible_by_declaration` additionally reports the best value achievable by any
  allowed provider **and which provider achieves it** — for example, "p95 400 ms
  requested; the fastest allowed model floors at 780 ms."
- `unmet` additionally reports the observed value, the window it was measured over, and,
  for each candidate provider, why it was not selected.

A routing decision that cannot produce its binding reason is not acceptable: without it
the gateway cannot explain itself, and target-state routing the customer cannot
interrogate is indistinguishable from a black box.

Reporting reaches the customer through four surfaces:

1. A synchronous rejection of the target-document write, for `infeasible_by_declaration`.
2. A per-workload status resource — the **authoritative** record of the current state.
3. A signed notification on every entry into and exit from `unmet`, delivered
   at-least-once with bounded retry. It is a notification, never the record: an
   undeliverable notification may be dropped, because the status resource still holds the
   truth. This matters because a customer's notification endpoint is frequently down for
   the same reason their target is unmet.
4. A response header on requests served while the workload is `unmet`, so a customer can
   correlate an individual slow request with a known state. In normal operation the gateway
   is not in the request path, so this header is written by the *connector* from the state
   the gateway pushes it — unlike the interception header of behavior 2, which the gateway
   writes because during a window it genuinely is in the path. The distinction costs the
   customer nothing: what made that record worth having is that it lands in logs the
   customer keeps, not which of the gateway's components authored it. The status resource
   remains authoritative either way.

There is no third infeasibility state for "the gateway's own capability floor was wrong",
and that gap is closed deliberately rather than left open. A wrong floor is the one path on
which this section's promise can fail without anyone noticing: it presents to the customer
as ordinary provider degradation, indistinguishable from the `unmet` they would see if the
provider had genuinely slowed. So the state stays `unmet`, and the *correction* is reported
separately — flagged on the status resource whenever a target was accepted against a floor
since corrected, and delivered as a notification in the single case where the customer is
otherwise misled: a workload already `unmet` on a dimension whose corrected floor now
exceeds their target. A routine floor refresh is not an event a customer hears about; being
told wrong is.

Target state is deliberately **not** reported on the bill. The original reason — that
pricing was undecided — has expired, and the coupling now runs the other way: the invoice
is computed from this behavior's own telemetry. The decoupling stands on a different
footing. `unmet` printed next to a charge reads as a claim, and the only claim the gateway
honors attaches to control-plane availability, never to provider outcomes (see
[Pricing model](#pricing-model)). Putting target state on the invoice would invite the
refund conversation that incident-conditional billing was rejected to avoid.

### Relaxation

When no mix satisfies every ceiling, the lowest-priority ceiling yields first, and the
gateway reports `unmet` for it. A dimension marked hard never yields: the request fails
instead. Customers who declare no priority and no hard dimension still get deterministic,
explainable behavior from the defaults above rather than gateway discretion — the point
of this behavior is that the gateway's choices are predictable without a routing rule.

## Strain-triggered interception in detail

This section specifies required behavior 2. Terms in *italics* on first use are defined in
[`CONTEXT.md`](../../CONTEXT.md).

### What interception is for

In normal operation the customer's connector calls the provider directly and the gateway
influences routing only by pushing a base-URL directive the connector acknowledges
([#4](https://github.com/hoomji/henry-ai-router/issues/4)). A directive can move all of a
workload's traffic from one provider to another; it cannot decide anything per request.

Interception exists for the one thing a directive cannot do: **fail an individual
in-flight request over to another provider**. The connector cannot do this itself without
holding every provider's credentials, and that is the install burden this product refuses.
Prompt translation (behavior 5) rides on the same moment, because a cross-model failover is
where a prompt written for one model meets another.

It follows that interception is for **partial** failure — a rate-limit storm or an elevated
error rate, where most requests succeed and each one needs its own decision. Two conditions
that sound like they belong here do not, and are named to make the narrowed trigger set
legible rather than to imply an omission:

- A provider that is **fully unavailable** needs a directive, not the data path. Every
  request would fail over, so moving the whole workload is both sufficient and cheaper.
- A **model deprecation** is known in advance and is a scheduled directive. The gateway
  does not detect deprecation by watching errors, and no window opens for one.

### What declares a window's start

Detection reads *provider strain*: rate-limit and error pressure aggregated across the
customer base, keyed to `(provider, model, region)`.

- Thresholds are stated as **banded deviation from that provider's own trailing 24-hour
  baseline**, never as absolute rates. A normal 429 rate differs by model, tier, and
  region, so a single absolute number is wrong nearly everywhere.
- **429s attributable to a customer's own quota are not strain.** A request throttled
  because that customer exhausted an org-scoped limit says nothing about the provider, and
  counting it would let the single noisiest tenant open windows for everybody. Such
  responses are distinguished by their limit and reset headers and excluded from strain
  evidence. They remain actionable for the customer they belong to, as their own condition.
- The strain signals published across the customer base are bucketed, banded, and delayed
  by the aggregation contract in
  [#5](https://github.com/hoomji/henry-ai-router/issues/5). **That contract governs
  disclosure, not detection.** Detection runs against the internal aggregate at fine
  granularity, because a detector reading the published feed would declare minutes after
  onset and forfeit the sub-second insertion the mechanism exists to provide. Recorded in
  [ADR 0005](../adr/0005-strain-evidence-detection-internal.md).

A window may open on cohort evidence alone, before the customer's own traffic has shown
anything — this is behavior 3's promise, and waiting for their first 429 would restore
exactly the reactive posture this product replaces. The window then carries an **evidence
class** of `anticipatory` rather than `observed`, and an anticipatory window may open only
on corroboration across **at least two signal types or two disjoint cohorts**, so no single
source can produce one.

Windows open **automatically**. An operator may force-clear or suppress one, and may never
open one; every such override is recorded with its actor. A human in the opening path would
spend the entire insertion-latency budget, and [ADR
0004](../adr/0004-incidents-included-not-surcharged.md) has already removed the incentive
that would make automatic opening untrustworthy — no charge depends on a declaration.

### What ends one, and why the edges are asymmetric

Entry is fast and exit is slow, deliberately, and this is **not** the symmetric rule
`unmet` uses. The two-window symmetry there protects a *report*, where flapping gets the
alert muted. A window is an *action*: it is free, reversible, and its costs point one way —
opening late costs the customer failed requests, closing late costs only gateway compute.
So a window opens on a single corroborated interval and closes only on sustained recovery.

Recovery is proved by **canary traffic through the gateway**: a fraction of real requests
attempt the strained provider first and fail over on error. Synthetic probes on a
gateway-held key measure the wrong account, since rate limits are scoped per organization,
and releasing traffic direct to test would make the customer pay for the experiment with
unprotected requests during a window opened to protect them. A consequence to accept: the
tail of every window is mixed, so **interception is a per-request property, not a
per-window one**, and neither the audit record nor this specification may describe a window
as an interval in which everything was intercepted.

### What the customer can audit

The window's edges are the **acknowledged** ones. The gateway declares, the connector
acknowledges, and traffic between those two moments went direct — so the acknowledged edge,
not the declaration, bounds which traffic was actually intercepted. Both are recorded: a
persistently wide gap means a connector running on the polling fallback rather than a pushed
directive, which is a degradation the customer is otherwise never told about.

The audit record is held at **window granularity**, and the per-request truth reaches the
customer as a **response header on every intercepted request**, following the precedent
behavior 1 already sets for `unmet`. This one is written by the gateway itself, which is in
the request path for the window's duration — behavior 1's equivalent is written by the
*connector*, because in normal operation the gateway is not. The header is mandatory, not
optional: written at request time into logs the gateway does not control, it is the one part
of this record the customer holds independently of us — which matters, because our own account of what we did
during a window is otherwise unfalsifiable by them.

Every window carries a **binding reason**, on the same standard behavior 1 sets for routing
decisions: a window that cannot state why it opened must not open. Disclosure is capped at
what the aggregation contract permits publishing — the evidence class, which signal types
corroborated, the banded deviation, and the providers involved. **Cohort size and
composition are never disclosed**, because that is precisely the inference one customer
must not be able to make about another. An `anticipatory` window therefore discloses less
than an `observed` one, whose evidence is the customer's own traffic. That difference is
stated to the customer rather than smoothed over.

Window records are **append-only**: a correction is appended and never rewrites what was
recorded, and records are retained for at least thirteen months, so any renewal
conversation can reach the whole prior term.

## Collective strain signals in detail

This section specifies required behavior 3 and resolves
[#10](https://github.com/hoomji/henry-ai-router/issues/10). Terms in *italics* on first use
are defined in [`CONTEXT.md`](../../CONTEXT.md).

### What a customer contributes, and on what terms

A *strain contribution* is the provider-observed outcome of one of the customer's own
requests — its status code and its latency — recorded against the *cell* the request went
to. Contributing is a **condition of service**: not an opt-in, not an opt-out, and not a
per-customer setting.

The mandate is bounded, and the bound is what makes it defensible. A contribution carries
only facts the provider side of the connection already observed. It never carries request or
response content, token volumes, per-customer request counts, or any customer identity. A
customer who contributes gives up nothing they hold exclusively: the provider already saw
every fact in it.

Two alternatives were rejected. Opt-in never reaches the *cohort* size the behavior requires,
so the behavior never starts. Opt-out admits free-riding — consume cohort evidence,
contribute none — and silos the network effect one tenant at a time, satisfying the letter of
the Constraints section's prohibition on siloed architecture while defeating exactly what it
protects. Recorded in [ADR
0007](../adr/0007-strain-contribution-is-a-condition-of-service.md).

This is not a mechanism that makes leaving costly. Contribution is a condition of *use* and
stops when use stops; nothing contributed is data a departing customer loses or cannot take
with them.

### What a connector that contributes nothing means

A *connector* reporting nothing — an old version, one degraded onto the polling fallback, or
one deliberately stripped — is a **stated degradation**, surfaced on the status resource as
non-contribution.

Routing continues. What the customer loses is `anticipatory` windows, and the reason is
mechanical rather than punitive: an anticipatory window is opened per customer and workload
against the cells that customer is currently routing to, and a connector that reports nothing
leaves the gateway without a current picture of which cells those are.

Cohort evidence is **not** withheld as a sanction. Withholding protection from a customer
whose connector broke punishes them for a fault that is usually ours, and it turns a privacy
mechanism into a commercial lever. The commercial conversation follows the evidence on the
status resource rather than being enforced in the routing path.

This introduces no new detection. A connector reporting nothing is already a metering failure
under the Constraints section's requirement that usage metering run for every connected
customer: the same silence is the same signal.

### The aggregation contract

Detection and disclosure are separate, per [ADR
0005](../adr/0005-strain-evidence-detection-internal.md). Detection reads the internal
aggregate at fine granularity; the contract below binds **disclosure** — anything a customer
is shown — and nothing else.

The contract originates in [#5](https://github.com/hoomji/henry-ai-router/issues/5), which
wrote it to govern a published feed. No such feed exists (see [Whether the feed is a
product](#whether-the-feed-is-a-product)), so each provision is recorded here with the
subject it actually has, including the one that has none.

**Cohort minimum.** No cohort-derived value may be disclosed to any customer unless at least
**twenty** distinct customers contributed to the cell. #5 sets ten generally and twenty where
the recipient also contributes to the cell, so that subtracting their own contribution still
leaves ten others. Because contribution is a condition of service, every recipient is a
contributor to every cell they route through: the differencing case is not the exception
here, it is the only case, and twenty is the operative number. A cell below the threshold is
absent — never zero-filled, never noised.

**Bucketing, and the publication delay that does not survive.** Bands are computed over
five-minute buckets. #5 also requires publication one full bucket late, and that provision
**has no subject and is dropped**. Its purpose was to stop a customer correlating flickers in
a polled feed against their own request timing; the only disclosure that remains is
contemporaneous with the routing action that requires it, and delaying it would mean telling
a customer why their traffic moved five minutes after it moved. It is recorded as dropped
rather than silently omitted, because the reasoning behind it is sound for the feed it was
written for and would otherwise be reintroduced by the next reader of #5.

What replaces it addresses the same attack directly: **there is no pollable strain surface**.
A correlation attack needs a time series and a time series needs an endpoint. Cohort-derived
values are disclosed only as a snapshot attached to a decision record — an *interception
window* or a *ranked list* change — and never as a queryable resource.

**Signals and their bands.** Three signals are aggregated: 429 rate, 5xx rate, and latency
deviation. All three disclose on one scale — `none`, `elevated`, `severe` — quantized as a
fraction of cohort requests for the two rate signals, and as deviation from that provider's
own trailing 24-hour baseline for latency, on the same standard [What declares a window's
start](#what-declares-a-windows-start) already sets for thresholds. One scale rather than
two: a second three-valued vocabulary for the same quantity would eventually be read as a
distinct set of states.

**Never disclosed.** Absolute request counts, token volumes, or contributor counts per cell.
Cohort size and composition. Any per-customer dimension. Unquantized rates — over a cohort
this size, a rate carried to several decimal places is a count. The exact minute a strain
condition began. Anything derived from a single customer's payloads.

**Cell keys collapse on disclosure.** Strain is aggregated internally under `(provider,
model, region)`. Anything disclosed is keyed no finer than `(provider, model-family)`. A
sparsely used region is close to naming its occupants: a cell with three customers in it
identifies them to anyone who knows the customer base. Throughout this specification *region*
means the **provider's** serving region and never the customer's, which is never a key of
anything.

**Change-based suppression.** A disclosed *band* must not move on the addition or removal of
any single contributor. Over at least twenty contributors with three bands this is nearly
automatic, which is the point: the coarseness is not a presentation choice, it is what makes
the cohort minimum mean anything. Separately, a customer receives **at most one disclosure
per cell per bucket**, however many *workloads* they run. Without that rule a customer with
forty workloads collects forty samples of one cell and reconstructs by repetition what the
cohort minimum exists to prevent. #5 does not state this; it is forced by the per-workload
structure of this product, which #5 did not know about.

**Corroboration.** A cohort-derived routing change requires agreement across at least two
signal types or two disjoint cohorts. [What declares a window's
start](#what-declares-a-windows-start) already requires this of an `anticipatory` window; it
binds a *ranked list* change equally. The cost asymmetry that justifies fast window entry
does not hold for a shift: a window is free, reversible, and decided per request, while a
shift moves all of a workload's traffic onto a provider with different latency, cost, and
output characteristics, with no per-request failover softening it. The blunter action does
not get the weaker evidence rule.

### What a customer is told, and what is withheld

Disclosure is tiered, because the parts of a binding reason differ in what they leak.

- **At any cohort size**: the *evidence class*, which signal types corroborated, and the
  providers involved. These are facts about the gateway's decision rather than values
  computed over a cohort, and no contributor can be differenced out of them.
- **At twenty contributors or more**: the *band*. It is the only k-sensitive value a binding
  reason carries.

So between the behavior's start and a cohort of twenty, a customer learns that cohort
evidence moved their routing and what corroborated it, but not how strained the provider is.
This is a second disclosure asymmetry alongside `anticipatory` versus `observed`, and it is
stated to the customer rather than smoothed over.

### What the customer sees when routing shifts

A shift on cohort evidence in normal operation is a *directive* carrying a new *ranked list*.
It is **not** an *interception window*: no window record exists and no per-request response
header is written, because the gateway is not in the request path. The strongest audit
surface in this product is structurally unavailable exactly where the anonymization question
is sharpest, and this specification states that rather than implying parity — a cohort-driven
shift is less auditable than an interception window, because we were never in the path to
prove what we did.

What the customer gets instead is the **binding reason** the ranked list already owes them on
the standard behavior 1 sets — a routing decision that cannot state why it chose must not be
made — carrying the tiered disclosure above and capped by it. It appears on the **status
resource**.

It does not produce a notification. A shift that holds the target is the product working as
sold, and paging a customer for it trains them to ignore the notifications that matter. A
notification follows only when the shift also moves the workload into `unmet` or breaches a
ceiling, which are behavior 1's existing conditions.

### The two aggregates must not be wired together

[ADR 0005](../adr/0005-strain-evidence-detection-internal.md) records, as a consequence of
splitting detection from disclosure, that two aggregates now exist and that letting a
customer-facing surface read the internal one is a privacy failure no test currently catches.
Behavior 3 is the behavior that makes that hazard live, so the guard ships with it: no
customer-facing surface may read the internal fine-grained aggregate, and the check is
structural. Sampling outputs for leaks tests the wrong property; what is worth enforcing is
that the wire between the two does not exist.

### Whether the feed is a product

Publishing a provider-health feed is **not part of this behavior** and remains an open
decision (see [Open product decisions](#open-product-decisions)). If it is taken, it is
served from **gateway-run synthetic probes** and never from customer contributions. A
customer-derived feed would place the network effect's output and the product's largest
disclosure surface in the same pipe, and would hand a competitor the value of a customer base
they do not have. A synthetic feed carries no contribution from anyone, and therefore no
anonymization contract at all.

The objection ADR 0005 raises against synthetic probes does not apply here. That objection is
that a probe on a gateway-held key measures the wrong account, because rate limits are scoped
per organization — decisive for proving one customer's recovery, irrelevant to publishing
coarse provider availability.

### When this behavior starts

Behavior 3 is deferred on a customer count, and the trigger and its basis are stated in
[Behavior 3 is deferred on customer count](#behavior-3-is-deferred-on-customer-count).

**Contribution does not wait for it.** Connectors report *strain contributions* from the day
the connector exists, on the same reasoning the Constraints section gives for metering: a
cohort cannot be built retroactively, and the trigger counts customers *concurrently
connected* per cell, so a behavior that begins collecting on the day it is built can never
find its trigger already met. What is deferred is the aggregate and everything downstream of
it — cohort membership, banding, disclosure, and routing on the result — not the reporting.

## Pricing model

This section resolves whether behaviors 2 and 4 can coexist as business models
([#7](https://github.com/hoomji/henry-ai-router/issues/7)). They can, because neither one
is a business model once its terms are separated. Behavior 2 welded two claims into one
sentence — *the gateway is out of the path* (a data-path fact) and *the gateway charges
only during incidents* (a commercial fact). Behavior 4 was named for a pricing mechanism
it does not require. Unwelding the first and removing custody from the second leaves a
single pricing model with two behaviors hanging off it.

The customer-facing promise is **not** "you are billed only during incidents." It is *you
do not pay for our presence in your request path; you pay for provider risk absorbed.*

### What the customer pays

A flat subscription, tiered on **spend under management**: the customer's provider spend
for traffic the gateway manages, computed from the connector's reported token counts against
a published **rate card**. There is no percentage of spend, no per-request markup, and no
per-incident fee.

The rate card is a versioned artifact distinct from the *capability catalogue*. The two
carry the same units and incompatible obligations: a capability floor is an optimistic
claim about what a provider can do, is permitted to *abstain* when its sources go stale
([ADR 0003](../adr/0003-provenance-tiered-capability-catalogue.md)), and is corrected
backwards when it turns out wrong. A billing rate may do none of those things. The rate
card may be derived from the catalogue on a slow cadence, but it changes only forward and
a floor correction never restates a settled invoice.

Token counts are reported by the customer's own connector. That is accepted rather than
audited: the code that reports usage is the code that receives the routing benefit, so
under-reporting degrades the customer's own provider mix.

### What interception costs

Nothing beyond the subscription. The gateway opens the *interception window*
([#9](https://github.com/hoomji/henry-ai-router/issues/9)), and a gateway paid by its own
declarations cannot be trusted to make them honestly. Interception cost is priced into the
tier, not recovered from it; margin is therefore worst in the month a provider degrades
badly, which is accepted. Recorded in
[ADR 0004](../adr/0004-incidents-included-not-surcharged.md).

The one place detection touches money runs the opposite way. When *provider strain* is
present and the gateway fails to push a directive the connector acknowledges — the control
plane is down, or the connector is stuck on the polling fallback — the customer keeps hitting
a degrading provider. That period counts against **control-plane availability** and
produces the same unprompted credit as any other control-plane failure. The gateway
therefore loses money by failing to open a window and gains nothing by opening one, which
is the exact inverse of the surcharge ADR 0004 rejected.

### What a bypassed customer owes

Bypass is free, in both of its forms, and this is deliberate.

- **Involuntary** (the gateway is unavailable, fail-open fires): the customer is owed a
  credit against **control-plane availability** — whether the gateway can serve the status
  resource and push a routing directive a connector acknowledges. Never against request
  success, which belongs to the provider and which fail-open exists to preserve. Because
  the gateway is out of the path, a control-plane outage is not observable to the
  customer: their traffic continues to the last-directed provider. The credit is therefore
  **self-issued from the gateway's own measurement**. A credit only the vendor can detect
  is either a written commitment or nothing at all.
- **Voluntary** (the customer removes the connector and stops paying): permitted, and no
  mechanism exists to make it costly. Any such mechanism would make the gateway the
  always-on middleman the non-goals forbid. Retention rests on the connector degrading to a
  static base URL without a live control plane — no mix, no feasibility check, no strain
  signal, no interception. If that is not enough, the product is wrong, and that is
  to be learned from churn rather than prevented by lock-in.

### Reservations

A reservation is **customer-held and customer-declared**. The gateway never buys, holds,
or resells provider capacity: if the gateway held the reservation, bypassing the gateway
would forfeit capacity the customer paid for, which inverts the promise above and would
make this a capacity-broker business carrying provider commitments on its own books.

The customer declares each reservation (host, model, size, term, effective rate) in its own
resource, **not** in the *target document*: a target states an outcome the customer wants,
a reservation states a fact about their contract with a provider, and holding both in one
versioned document would let a term expiring change what a target means without the customer
writing anything. Utilization is computed from the connector's own telemetry rather than from
the provider,
because the authoritative provider signals do not serve routing: Azure publishes
`Provisioned-managed Utilization V2` but Azure Monitor lags 30 seconds to 15 minutes,
against a 5-minute measurement window, and Bedrock publishes no utilization figure at all.
A read-only cloud credential may be offered as optional corroboration; it is never
required, because that grant is a far heavier install than the connector the gateway already
needs.

Nothing is reclaimed and nothing appears on the gateway's invoice — the reservation is a
contract between the customer and their provider. What the gateway owes is visibility and
routing: the most common cause of an idle reservation is a call site that never addresses
it (on Bedrock, passing the foundation-model ID instead of the `provisionedModelArn`), and
that is visible at the call site where the connector already sits.

A declared reservation makes `cost_per_1k_tokens_usd` **customer-specific**, which the
capability catalogue's global `(model, host, region, service_tier)` key does not currently
express. Reconciling that is
[#12](https://github.com/hoomji/henry-ai-router/issues/12)'s.

## Behavior sequence and deferrals

This section resolves which behavior is built after target-state routing and which are
deferred ([#8](https://github.com/hoomji/henry-ai-router/issues/8)). It belongs in the
specification rather than in a plan because two of the five behaviors are deferred on
*product* conditions — a customer count and a dependency between behaviors — that no
implementer can evaluate from the code.

### The connector comes before any second behavior

What follows behavior 1 is not a behavior. The *connector* is the customer-installed
component this specification already leans on everywhere: it reports the token counts that
compute *spend under management*, it acknowledges the *directive* whose edges bound an
*interception window*, it supplies the telemetry that shows a *reservation* going
unaddressed, and it sits at the call site where the most common cause of an idle
reservation is visible. The Constraints section's requirement that metering run "for every
customer from the first day they are connected" cannot start until it exists.

It is also how behavior 1 reaches a customer at all. The gateway is out of the request path
in normal operation, so target-state routing is delivered as a *ranked list* pushed to the
connector, not as a per-request choice made inside the gateway. Routing policy stays
gateway-side and the connector holds none of it, per ADR
[`0006`](../adr/0006-routing-authority-stays-gateway-side.md).

Naming it as a prerequisite rather than a sixth behavior is deliberate. Folded into
whichever behavior is built next, its scope would never be argued on its own terms, and
every behavior after that would inherit a component nobody specified.

### Behavior 4 is the second behavior

Reservation-aware routing requires nothing beyond the connector: no provider credentials, no
cross-customer cohorts, no multi-tenancy past what the connector already forces. A declared
reservation is a customer-specific `cost_per_1k_tokens_usd` floor and a routing preference —
both extensions of machinery behavior 1 builds.

A reservation is **not** part of the *target document*. A target states a desired outcome;
a reservation states a fact about a contract with a third party, and folding the two together
would let a reservation's term expiring silently change what a target means with no customer
write. Reservations are their own customer-authored resource, read by the feasibility check
and by routing.

### Behavior 2 is third

Strain-triggered interception is the sharpest differentiator and the most gated: it needs the
connector, it needs the gateway to hold provider credentials (which is the entire reason
interception exists — see [What interception is
for](#what-interception-is-for)), and its `anticipatory` evidence class needs behavior 3.

### Behavior 3 is deferred on customer count

Collective fatigue-aware routing cannot be built early, and the obstacle is commercial rather
than technical. The trigger is approximately **ten concurrently connected customers per
`(provider, model, region)` cell**.

That number is derived from statistical power and the corroboration rule, **not** from the
aggregation contract's cohort minimum. The contract's thresholds bind disclosure and not
detection ([ADR 0005](../adr/0005-strain-evidence-detection-internal.md)), so a suppressed
cell stops nothing the detector does. What stops the behavior below ten is that a
cohort-derived routing change requires corroboration across two signal types or two disjoint
cohorts, and neither is reachable from a handful of contributors: the aggregate is noise with
no population in it to separate a provider's degradation from one customer's bad afternoon.

A second threshold sits above the trigger and gates disclosure rather than the behavior. The
*band* a binding reason carries requires twenty contributors to the cell, so between ten and
twenty the behavior runs and the customer is told less about it — see [What a customer is
told, and what is withheld](#what-a-customer-is-told-and-what-is-withheld).

The consequence for behavior 2 must be stated rather than discovered: until that trigger is
met, behavior 2 opens `observed` windows only. `anticipatory` windows — the ones that open
before the customer's own traffic degrades, which is the reactive-to-proactive difference this
product sells — are gated on the same customer count, and a behavior 2 built as though cohort
evidence were available on day one would ship the reactive posture the product claims to
replace.

### Behavior 5 is deferred behind behavior 2

Semantic-fidelity prompt translation follows behavior 2, because the moment it exists for is a
cross-model failover mid-window.

Behavior 1 does not need it, and that is a claim about `allowed_models` worth making
explicitly. A customer's `allowed_models` list is their assertion that those models are
interchangeable *for that workload* — they drew the blast radius, and routing within it is
what they asked for. The gateway does not adapt a prompt when it moves a request between two
models the customer listed, and a customer who does not want a model's output is expected to
remove it from the list rather than to receive a translated approximation of another model's
behavior.

### What the deferrals mean for the design

- **Streaming splits.** The connector is in the streaming path from its first day — real chat
  traffic streams, and the connector calls providers directly — but it only needs to pass a
  stream through and count tokens at the end. The adapter contract's chunk transform is needed
  only when the gateway transforms mid-stream, which is behavior 2. "Streaming is deferred" is
  true of the adapter contract and false of the connector.
- **Authentication arrives with the connector; cohort multi-tenancy does not.** A connector
  must identify itself to receive a directive and report token counts, and metering across
  every connected customer makes a single hardcoded customer key untenable. That is an
  identity change. The larger data-model change — cohort membership across customers — stays
  with behavior 3.

## Boundaries and failure behavior

- If the gateway itself is unavailable, customer traffic must still flow directly to the
  customer's configured provider (fail-open); the gateway must never become a worse
  single point of failure than the providers it manages.
- A stated target (behavior 1) that no provider mix can satisfy must be reported, not
  silently best-effort, as one of two distinct states: `infeasible_by_declaration`
  (rejected at write time) or `unmet` (raised at runtime). Each report must name the
  dimension, the target, and the binding reason. See
  [Target-state routing in detail](#target-state-routing-in-detail).
- A target change takes effect within approximately five seconds of being written, not
  instantly. A successful write to the target document means the change is *committed*,
  not that it is already in force for every in-flight request. Reads of the document
  reflect it immediately; routing behavior follows within that bound.
- If the gateway's target storage is unavailable or corrupt at startup, traffic is
  forwarded to the customer's configured provider without target-state routing, and the
  management surfaces report the failure. Targets are never treated as absent because
  storage failed: an unreadable store and a customer who has stated no targets must not
  look alike.
- A workload's `unmet` state survives a gateway restart; its measurement window does not.
  For the first window after a restart a workload may be reported as `unmet` and
  `insufficient_data` at once — the first is a claim about the past, the second about the
  present.
- Cross-customer strain signals (behavior 3) must be anonymized and aggregated; one
  customer's traffic pattern must not be inferable by another.
- An *interception window* (behavior 2) must have explicit start and end so customers can
  audit exactly which traffic was intercepted. Its edges are the ones the connector
  acknowledged, and the per-request tag on an intercepted response is the finest-grained
  record; a window is never described as an interval in which all traffic was intercepted,
  because its tail carries canary requests. The window is an audit boundary, not a billing
  boundary: no charge depends on it.
- A window whose record cannot be written is still opened — customer availability outranks
  the gateway's own bookkeeping — and the gap is disclosed as an unrecorded window. A
  period the gateway cannot account for and a period in which nothing happened must not
  look alike.
- An *interception window* opened on cohort evidence alone must be distinguishable from
  one opened on the customer's own traffic, and neither may disclose cohort size or
  composition. A window that cannot state its binding reason within those limits must not
  open.
- A control-plane outage is not observable to the customer, because their traffic
  continues to the last-directed provider. The gateway must therefore measure its own
  control-plane availability and issue the resulting credit unprompted; a customer is
  never required to detect a breach in order to be owed for it.
- Prompt translation (behavior 5) must be able to report that no faithful translation
  exists and fall back to the untranslated prompt rather than silently altering intent.

## Non-goals

- Not another always-on unified-API router; structural/API normalization is table stakes
  elsewhere, not the product here.
- Not a model-quality benchmark or evaluation service.
- Not per-tenant routing-rule configuration ("if X then route to Y") as the primary
  interface; rules may exist as an escape hatch only.

## Constraints

- Contributing strain evidence is a condition of service, not a per-customer setting. The
  gateway's value proposition depends on the network effect of cross-customer strain
  (behavior 3), and a per-tenant opt-out silos that effect one tenant at a time as
  effectively as a siloed architecture would. The mandate is bounded in the same breath: a
  *strain contribution* carries only facts the provider side of the connection already
  observed — status codes and latencies — and never request or response content, token
  volumes, per-customer counts, or customer identity.
- Usage metering must run for every customer from the first day they are connected,
  including customers who are not being billed. Tiers are flat and indexed to computed
  spend, so their boundaries are guesses until a real token distribution exists — and the
  meter is the same telemetry behavior 1 already requires, so the obligation costs nothing
  to honor early and is expensive to retrofit. (Replaces an earlier constraint requiring
  pricing behaviors 2 and 4 to be pilotable with a subset of customers; there is no longer
  any per-customer pricing variance to pilot.)
- The gateway must not acquire a mechanism that makes leaving it costly — no held
  reservations, no custody of provider contracts, no data a departing customer cannot take
  with them. Bypass staying free is what distinguishes this product from the always-on
  middleman the non-goals exclude. Mandatory strain contribution is not such a mechanism: it
  is a condition of use rather than a hold on the customer, and nothing contributed is data a
  departing customer loses or cannot take with them.

## Acceptance criteria

- [x] A customer can state a per-workload target over `p95_ms`,
      `cost_per_1k_tokens_usd`, and `success_rate` and observe the gateway change provider
      mix in response to drifting provider performance without a routing rule (behavior 1).
- [x] A target no allowed provider can satisfy is rejected when written, with a report
      naming the dimension, the requested value, the best achievable value and the
      provider achieving it, and the provenance and age of the capability floor the
      rejection rests on (behavior 1, `infeasible_by_declaration`).
- [x] A target whose candidate capability floors have all gone stale is accepted rather
      than rejected, and the abstention is observable (behavior 1).
- [x] A capability floor correction leaves every existing target document valid and in
      force, flags the affected workloads on the status resource, and notifies only a
      workload already `unmet` on the corrected dimension (behavior 1).
- [x] A target that stops holding at runtime raises `unmet` after two consecutive missed
      windows and clears after two consecutive held windows, visible on the status
      resource, the notification, and the response header, with a per-provider reason for
      each rejected candidate (behavior 1, `unmet`).
- [x] When ceilings conflict, the lowest-priority ceiling yields and is reported; a
      dimension marked hard fails the request instead of being breached (behavior 1).
- [ ] Traffic outside an interception window reaches the provider without gateway
      interception; every intercepted request carries a tag identifying its window, and
      the window's acknowledged edges and its declaration times are both visible to the
      customer (behavior 2).
- [ ] A window opened on cohort evidence before the customer's own traffic degraded is
      reported as `anticipatory`, names the signal types that corroborated it and the
      banded deviation, and discloses no cohort size or composition (behavior 2).
- [ ] Provider strain that the gateway fails to act on — no directive pushed and
      acknowledged — produces a control-plane availability credit the customer did not
      have to ask for (behavior 2, pricing model).
- [ ] Two customers with identical traffic and different interception histories receive
      identical invoices; no invoice line varies with whether a window was opened
      (behavior 2, pricing model).
- [ ] A period in which the gateway could not serve the status resource or push a routing
      directive produces a credit the customer did not have to ask for (pricing model).
- [ ] When one customer's traffic strains a provider, another customer's routing shifts
      away from that provider before receiving a rate-limit error, and the shift carries a
      binding reason on the status resource naming its evidence class, the signal types that
      corroborated it, and the providers involved (behavior 3).
- [ ] No customer-facing surface — status resource, binding reason, window record, response
      header, or any published feed — can read the internal fine-grained strain aggregate;
      disclosure reads only the contract-bound aggregate, and a wire between the two fails
      the build rather than a review (behavior 3, [ADR
      0005](../adr/0005-strain-evidence-detection-internal.md)).
- [ ] Below twenty contributors to a cell, a cohort-derived binding reason names its evidence
      class and corroborating signal types and carries no band; at twenty or above it carries
      the band, and a customer running many workloads receives at most one disclosure per
      cell per bucket (behavior 3).
- [ ] A connected customer whose connector reports no strain contributions is shown as
      non-contributing on the status resource, and continues to receive routing (behavior 3).
- [x] A declared reservation that traffic is not addressing is surfaced to the customer,
      and eligible traffic is subsequently routed onto it ahead of on-demand capacity,
      with no provider credential granted to the gateway (behavior 4).
- [ ] A prompt authored for model A, routed to model B, produces the intended behavior on
      model B or an explicit fallback notice — never a silent semantic change (behavior 5).
- [x] A customer's traffic reaches providers directly through the *connector* while the
      gateway is out of the request path, with the connector obeying the *ranked list* the
      gateway pushed and acknowledging the *directive* that delivered it (connector).
- [x] A workload in `unmet` carries the target-state response header on requests the gateway
      never saw, and the status resource and that header agree (connector, behavior 1).
- [x] Token counts reported by the connector produce a *spend under management* figure for a
      connected customer who is not being billed (connector, pricing model).
- [ ] Below the cohort threshold, every *interception window* is classed `observed` and no
      window opens on cohort evidence (behavior 2 under the behavior 3 deferral).
- [x] With the gateway down, customer traffic still reaches the configured provider
      (fail-open boundary).

## Open product decisions

| Question | Blocking | Owner | Resolution |
|---|---|---|---|
| Which of the five behaviors is the initial wedge to build first, and in what order do the rest follow? | Yes — blocks any ExecPlan milestone ordering | henry.tran@uniblock.dev | Resolved ([#8](https://github.com/hoomji/henry-ai-router/issues/8)). Behavior 1 first (already locked by the tracer plan). What follows it is **not a behavior**: the *connector* is a prerequisite milestone, because behaviors 2, 3 and 4, the pricing model's meter, and behavior 1's own out-of-path delivery all sit on it. Then behavior 4 (reservation-aware routing), which needs no provider credentials, no cohorts and no multi-tenancy, and extends machinery behavior 1 already builds. Then behavior 2. Behaviors 3 and 5 are deferred on stated triggers — see [Behavior sequence and deferrals](#behavior-sequence-and-deferrals). |
| Is incident-only pricing (behavior 2) compatible with usage-decay pricing (behavior 4) in one business model? | No | henry.tran@uniblock.dev | Resolved ([#7](https://github.com/hoomji/henry-ai-router/issues/7)). Yes — because neither survives as a business model once its terms are separated. Behavior 2 fused "out of the path" with "charged only during incidents"; the first is kept, the second is dropped, because the gateway declares the incident window and must not be paid by its own declarations ([ADR 0004](../adr/0004-incidents-included-not-surcharged.md)). Behavior 4 loses custody and becomes *reservation-aware routing*, a routing input rather than a price. What remains is one model: a flat subscription tiered on spend under management, computed from client telemetry against a forward-only rate card kept separate from the capability catalogue, with incidents included and bypass free in both directions. Specified in [Pricing model](#pricing-model). |
| Can a customer target a **monthly cost budget** rather than a unit rate? | No — behavior 1 ships with the unit rate | henry.tran@uniblock.dev | Deferred ([#6](https://github.com/hoomji/henry-ai-router/issues/6)). A unit rate is decidable from a state snapshot; a budget requires persistent spend accounting and an exhaustion policy (hard-stop, degrade, or notify), turning provider state from a snapshot into a ledger. Specify as its own behavior if wanted. |
| Should **error rate** be targetable separately from `success_rate`? | No | henry.tran@uniblock.dev | Deferred ([#6](https://github.com/hoomji/henry-ai-router/issues/6)). For a router the two collapse: a 429 the gateway re-routed is not a customer-visible error. Revisit only if a customer needs to see provider-level error pressure they are shielded from. |
| Should a customer be able to see, or set, the confidence the feasibility check needs before it rejects? | No — the margin ships as a fixed rule | henry.tran@uniblock.dev | Open ([#12](https://github.com/hoomji/henry-ai-router/issues/12)). Rejection is biased optimistic with a variance-based margin the customer cannot see or tune. A customer who genuinely wants a strict pre-flight check ("reject unless you are certain") has no way to ask for one, and a customer who wants none has no way to opt out. Revisit once abstention and false-`unmet` rates are observable. |
| Should **throughput / rate-limit headroom** be targetable? | No | henry.tran@uniblock.dev | Resolved ([#10](https://github.com/hoomji/henry-ai-router/issues/10)); deferred earlier on this question in [#6](https://github.com/hoomji/henry-ai-router/issues/6) pending behavior 3's specification. **No, and the vocabulary stays closed at three.** Specifying behavior 3 turned the objection from a matter of timing into a structural one: headroom is a property of a *cohort* at a moment, so it has no *capability floor* for `infeasible_by_declaration` to check and would abstain permanently, and it reaches a customer only as a *band* above twenty contributors, which is not a value anyone can hold the gateway to. Its customer-visible consequence is already covered by `success_rate` plus the shifts behavior 3 makes unasked. Generalized as an admission rule in [What a customer can target](#what-a-customer-can-target). |
| Is contributing strain evidence opt-in, opt-out, or a condition of service, and is #5's aggregation contract adopted as written? | Yes — blocks behavior 3 | henry.tran@uniblock.dev | Resolved ([#10](https://github.com/hoomji/henry-ai-router/issues/10)). Contribution is a **condition of service**, bounded to facts the provider side already observed ([ADR 0007](../adr/0007-strain-contribution-is-a-condition-of-service.md)). The contract is adopted with three changes: its cohort minimum is operative at **twenty** rather than ten, because condition-of-service makes every recipient a contributor and so makes #5's differencing case the only case; its one-bucket publication delay is **dropped** as having no subject once nothing is published; and its corroboration rule is **extended** to windowless routing shifts. Specified in [Collective strain signals in detail](#collective-strain-signals-in-detail). |
| Should the gateway publish a provider-health feed as a standalone product? | No — behavior 3 ships without one | henry.tran@uniblock.dev | Deferred ([#10](https://github.com/hoomji/henry-ai-router/issues/10)). OpenRouter publishes uptime charts with no stated anonymization contract, which is a real differentiation opening. If taken, the feed is served from gateway-run synthetic probes and never from customer contributions, which would otherwise put the network effect's output and the product's largest disclosure surface in one pipe. Revisit once behavior 3 is running. |

## Delivery evidence

Partially delivered as of 2026-08-16, at `e20ebea` on `master`. Behavior 1's decision
engine, the *connector*, and behavior 4 are implemented and have executable proof.
Behaviors 2, 3 and 5 are unclaimed, on the triggers recorded in [Behavior sequence and
deferrals](#behavior-sequence-and-deferrals).

Two ExecPlans carry the work and their own acceptance evidence:
[`2026-08-14-provider-risk-gateway-tracer.md`](../exec-plans/completed/2026-08-14-provider-risk-gateway-tracer.md)
(M1 fail-open pass-through, M2 target-state routing) and
[`2026-08-15-connector-and-reservation-aware-routing.md`](../exec-plans/completed/2026-08-15-connector-and-reservation-aware-routing.md)
(the connector, the gateway as a control plane, reservation-aware routing).

The named proof artifacts are commands, not prose:

| Artifact | What it proves |
|---|---|
| `npm --prefix gateway run load` | Setting a target moves the provider mix with no routing rule configured; exits non-zero on a flat split |
| `npm --prefix gateway run e2e` | Seven end-to-end checks against stub providers, including `unmet` reached on connector reports with zero in-path gateway requests |
| `npm --prefix gateway test`, `npm --prefix connector test` | 240 unit tests across both runtimes |
| `python scripts/check.py` (add `--e2e`) | The repository gate; runs both suites, and is demonstrated to fail on a failing test |
| `.github/workflows/gate.yml` | Both jobs green on a GitHub runner (PR [#15](https://github.com/hoomji/henry-ai-router/pull/15)) — the commands work off the machine they were written on |

Criteria proven by that evidence:

- All six behavior-1 criteria. Feasibility rejection with its disclosed basis, the
  stale-floor abstention, and the floor correction that leaves targets in force while
  flagging affected workloads are in `gateway/src/targets/feasibility.ts` and
  `gateway/src/targets/service.ts`, covered by `gateway/test/feasibility.test.ts` and
  `gateway/test/targetRouting.test.ts`. The two-window `unmet` hysteresis and the ceiling
  conflict in which the lowest-priority ceiling yields while a hard dimension truncates the
  candidate list are in `gateway/src/targets/unmet.ts` and
  `gateway/src/routing/chooseProvider.ts`, covered by `gateway/test/chooseProvider.test.ts`.
- The three connector criteria: traffic reaching providers directly while the gateway is
  out of the path and obeying a pushed ranked list it acknowledges; a workload in `unmet`
  carrying the target-state header on a request the gateway never saw; and token counts
  producing a *spend under management* figure. Checks 1–7 of the e2e run.
- The behavior-4 criterion: an unaddressed declared reservation surfaced with its call-site
  cause, and eligible traffic then routed onto it without a provider credential and without
  leaving `allowed_models`. `gateway/src/reservations/`, `gateway/test/reservations.test.ts`,
  and e2e check 6.
- The fail-open boundary criterion: with the gateway killed, the sample application keeps
  reaching its provider.

What this evidence does **not** establish, and no reader should infer:

- **Every run is against stub providers on localhost.** No provider credential, no
  deployment, no cloud account. The capability catalogue's realistic floors are plausible
  numbers, not measurements against a real provider.
- **`success_rate` is measured and honored but never driven to breach** by any verification
  artifact; the two dimensions with named artifacts are `p95_ms` and
  `cost_per_1k_tokens_usd`.
- **The connector contributes strain evidence but aggregates and discloses nothing**, so no
  behavior-3 criterion is claimed by it.
- **No pricing-model criterion is claimed.** The availability credit, invoice invariance,
  and window records depend on behavior 2.
- **CI cannot be made required** on this repository's plan, so a red run does not block a
  merge.
