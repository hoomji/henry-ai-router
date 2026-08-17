# Provider risk management as a product

A white paper for technical evaluators

- Owner: henry.tran@uniblock.dev
- Written: 2026-08-17
- Governing specification: [`../product-specs/provider-risk-management-gateway.md`](../product-specs/provider-risk-management-gateway.md)
- Companion: [`../design-docs/technical-blueprint.md`](../design-docs/technical-blueprint.md) — the
  system design this paper argues for
- Status of the thing described: two of five behaviors are implemented and proven by
  commands; nothing is deployed; every check but one opt-in command runs against simulated
  providers. See [Evidence, and what it does not establish](#evidence-and-what-it-does-not-establish).

Every number and mechanism in this paper has exactly one authoritative home elsewhere in
this repository, and is linked rather than restated as fact here. Where this paper and a
linked document disagree, the linked document is correct and this paper is a bug.

## Abstract

Teams that build on hosted AI model providers treat those providers as reliable, known
counterparties. They are not: providers rate-limit, degrade, deprecate models, and go down
without warning. Every AI gateway on the market responds to this by selling the customer
better tools for reacting — routing rules, fallback chains, a unified schema, dashboards —
and charges an always-on toll for sitting in the request path while the customer does the
reacting.

This paper argues that the product is the risk, not the plumbing, and that a specific
architectural choice is what makes that product coherent: **in normal operation the gateway
is not in the request path at all.** The customer's application calls the provider directly
through a connector installed at its own call site. The gateway is a control plane that
holds the customer's declared outcome, measures how each provider is doing from usage the
connector reports back, and pushes ordered lists of providers over Server-Sent Events. It
never carries the traffic.

That choice buys two properties no in-path gateway can offer, and forecloses several things
an in-path gateway gets for free. This paper states both, then states what has actually
been built and what the evidence for it does not prove.

## 1. The problem

The user is an engineering team running production traffic against one or more AI
providers. Their exposure has four distinct shapes, and they discover each one the same
way — after it costs them something:

- **Rate limiting.** A quota is exhausted, or the provider's own capacity is under
  pressure, and requests start returning 429.
- **Degradation.** The provider stays up and gets slower. Nothing fails; the p95 doubles.
- **Deprecation.** A model the customer's prompts were written against is withdrawn on the
  provider's schedule, not theirs.
- **Waste.** Capacity the customer has already paid for — Bedrock Provisioned Throughput,
  Azure OpenAI PTU — sits idle because a call site passes a foundation-model ID instead of
  the provisioned ARN. The invoice arrives either way.

The industry's answer to all four is configuration. The customer writes a fallback chain, a
weighted load-balancer config, a retry policy. That answer has a defect that is easy to
overlook because it is structural rather than technical: **a routing rule encodes what the
customer believed about their providers on the day they wrote it.** Provider behavior moves;
the rule does not. The customer is on the hook for noticing the drift and rewriting.

## 2. Why incumbents do not sell this

Nine gateways were surveyed against published documentation on 2026-08-15 — OpenRouter,
LiteLLM, Portkey, Helicone, Martian, Requesty, Unify, Kong AI Gateway, Cloudflare AI
Gateway — with per-vendor citations in
[the competitive landscape reference](../references/2026-08-15-ai-gateway-competitive-landscape.md).
Three findings matter for positioning.

**Failover and latency- or cost-aware routing are table stakes.** Both ship nearly
everywhere. Neither is a product; each is a feature the customer configures.

**Every published pricing model is always-on.** A percentage skim on money in (OpenRouter
5.5% on Stripe credits; Cloudflare Unified Billing 5%), a flat subscription metered on
request or log volume, an enterprise license, or plain per-token rates. No surveyed vendor
charges only when a failover fires. Two caveats belong with that finding and are recorded
in the reference: no incumbent has *validated* incident-conditional pricing either —
unclaimed is not the same as proven — and two vendors sell enterprise contracts with no
public rate card, so a private term cannot be ruled out from desk research.

**Resilience and optimization do not compose at the market leader.** OpenRouter's
uptime-aware load balancing is *disabled* the moment a customer sets `sort` or `order`. A
customer who asks for cheap traffic stops getting availability-aware routing, and nothing
tells them that trade was made. This is the sharpest single fact in the survey, because it
shows that even where the machinery exists, it is exposed as a switch the customer flips
rather than an outcome the vendor holds.

What is genuinely unclaimed: a bypass-by-default architecture, target-state routing that
continuously renegotiates a mix toward a declared outcome, pricing a reservation's idleness,
and selling the cross-customer strain signal itself. Two players aggregate multi-tenant
health data at all; one feeds it to its own routing and one publishes it without routing on
it. Nobody coordinates load across customers to pre-empt a 429.

## 3. The claim

**A customer states an outcome per class of traffic, and the system either holds it or
reports why it cannot — in a form the customer can interrogate.**

The unit is the *workload*, not the customer and not the model. An interactive chat path
and a batch summarization path want opposite trade-offs, and a single customer-wide target
cannot serve both. A target consists of ceilings or floors over a **closed vocabulary of
three** dimensions — `p95_ms`, `cost_per_1k_tokens_usd`, `success_rate` — one objective to
minimize, a priority order deciding which ceiling yields first, at most one *hard*
dimension that fails the request rather than being breached, and a required non-empty
`allowed_models` list that is the customer's explicit blast radius.

The vocabulary is closed under a stated admission rule: **a targetable dimension is a
property of a provider the customer could in principle verify, not a property of the
customer base.** That rule is what excludes rate-limit headroom, which is the case that
produced it — headroom is a property of a cohort at a moment, so it has no capability floor
to be checked against and would abstain permanently. Model quality is excluded on a
different ground: scoring it would make this a benchmarking service, and `allowed_models`
gives the customer the control they actually wanted without one.

Two things follow that are worth more than the vocabulary itself.

**Infeasibility is two states, never one** ([ADR 0001](../adr/0001-declaration-time-vs-observed-infeasibility.md)).
`infeasible_by_declaration` means no allowed provider *plausibly can* satisfy the target;
it is checked synchronously at write time and the write is rejected, so an impossible target
cannot be deployed. `unmet` means no mix *has* held the target over the measurement window;
it is a runtime state entered after two consecutive missed windows and left after two
consecutive held ones. The two have different truth conditions, different detection
latencies, and different meanings to the customer, and collapsing them would make the
report useless.

**A decision that cannot state why must not be made.** Both reports are diagnoses rather
than alarms: each names the dimension at fault, the targeted value, and the binding reason —
and for a rejection, the best achievable value, which provider achieves it, and the
provenance and age of the capability floor the rejection rests on. A bare number is not
disputable, and disputing it is the customer's only recourse against a floor that is wrong.
The same standard binds routing itself: the routing seam returns a decision carrying
per-candidate rejection reasons, not a provider, precisely so the reason cannot be
reconstructed from logs afterwards.

## 4. The architectural bet

In normal operation the gateway is a control plane and nothing else. The connector — a small
package the customer installs at their call site, with zero runtime dependencies outside the
Node standard library — makes the provider call itself, using the customer's own credential,
which never reaches the gateway. The gateway holds the target document, checks feasibility,
measures rolling windows, runs the `unmet` state machine, and pushes ranked provider lists.

The connector holds exactly one routing rule of its own: on a network error, a 429, or a
5xx, try the next provider in the list. All policy stays gateway-side
([ADR 0006](../adr/0006-routing-authority-stays-gateway-side.md)), so exactly one
implementation of the routing decision exists and exactly one authoritative binding reason
is produced. The pushed list is derived by calling the same routing function repeatedly
rather than by a second comparator, specifically so a second implementation cannot come
into existence.

Two consequences carry the argument.

**A gateway outage cannot stop customer traffic.** The connector keeps calling whichever
provider it was last told to prefer. The gateway is therefore not a worse single point of
failure than the providers it manages — which is the fail-open boundary the specification
states as a hard requirement. The price is precise and stated rather than hidden: a target
change takes effect within about five seconds rather than instantly, and a `200` on the
target write means *committed*, not *in force in every process*.

This also changes what an availability commitment can even be about. Because the gateway is
out of the path, **a control-plane outage is not observable to the customer** — their
traffic just continues to the last-directed provider. So the credit for one is measured by
the gateway itself and issued unprompted. A credit only the vendor can detect is either a
written commitment or nothing at all.

**Connector-reported usage is the only input the measurement windows have.** This is the
fragile half of the bet, and it is stated here because it has already broken once
invisibly: usage reports were persisted for billing and never folded into the measurement
windows, which left every provider `insufficient_data` forever and made `unmet` unreachable
— while every unit test passed, because every test of `unmet` reached the windows through
the in-path code path. The defect was caught by an end-to-end check, not by the unit suite.
The story is in the
[connector ExecPlan's *Surprises & Discoveries*](../exec-plans/completed/2026-08-15-connector-and-reservation-aware-routing.md),
and it is the best short read in this repository for anyone deciding whether to trust the
rest of it.

## 5. What the architecture forecloses

An out-of-path control plane is not free. Four costs are structural, not schedule-driven,
and an evaluator should weigh them against section 4 rather than after it.

**Budget enforcement is soft by default.** A synchronous "deny this call, it would exceed
budget" decision requires being at the moment of the call. So budget follows the same
push-and-reconcile shape as routing: the gateway pushes a snapshot, the connector
self-enforces, usage reports reconcile. Overspend is **bounded, not eliminated** — roughly
`report_interval × max_burn_rate` ([ADR 0008](../adr/0008-budget-enforcement-is-async-connector-side-by-default.md)).
Whether the market accepts that bound is the single question most likely to invalidate the
central bet, and it is open (#21).

**Some customers cannot install a connector at all.** A team on a managed platform with no
access to its own call site, or a regulated buyer who needs zero-overrun spend control, is
not unwilling — they are unable. The proposed answer is that in-path mode is **one
mechanism, a connector the gateway operates**, consuming the same ranked list from the same
control plane, rather than a second product with its own routing implementation
([ADR 0009](../adr/0009-in-path-mode-is-a-gateway-operated-connector.md)). The out-of-path
guarantee then narrows from a product-wide property to a per-workload one, which is a real
loss and is stated as one.

**A cohort-driven routing shift is less auditable than an interception window.** When the
gateway is in the path during a window it writes a per-request response header into logs it
does not control — the one part of the record the customer holds independently of us. A
shift made in normal operation cannot have that, because we were never in the path to prove
what we did. The strongest audit surface in the product is structurally unavailable exactly
where the anonymization question is sharpest. The customer gets the binding reason on the
status resource instead, and the asymmetry is disclosed rather than smoothed over.

**A wrong capability floor is indistinguishable from provider degradation.** The feasibility
check runs against floors that no provider publishes and that are therefore sourced by
measurement, carrying a provenance tier and an age
([ADR 0003](../adr/0003-provenance-tiered-capability-catalogue.md)). A too-optimistic floor
costs the customer a wait until `unmet`. A too-pessimistic one costs them a capability they
could have had, **silently and with no signal**, because a rejected target produces no
traffic to prove us wrong. Rejection is therefore deliberately biased against itself: a
target is rejected only when it fails the most optimistic candidate floor by more than that
floor's own variance, and when every source for a candidate has gone stale the check
**abstains and the write is accepted.** The residue is honest and narrow: a cold-start floor
is trusted, not verified, because the only thing that would validate it is the traffic whose
feasibility we are trying to decide.

## 6. Privacy is a design constraint, not a policy page

The product's network effect — one customer's traffic straining a provider moves another
customer's routing before they see a 429 — is also its largest disclosure surface. The
mechanisms that bound it are architectural, and four of them are worth an evaluator's
attention.

**Contribution is a condition of service, and bounded in the same breath**
([ADR 0007](../adr/0007-strain-contribution-is-a-condition-of-service.md)). A contribution
carries only facts the provider side of the connection already observed — a status code and
a latency, against the cell the request went to. Never content, token volumes, per-customer
counts, or customer identity. A customer who contributes gives up nothing they hold
exclusively. Opt-in was rejected because the cohort never forms and the behavior never
starts; opt-out was rejected because it admits free-riding and silos the effect one tenant
at a time. This is not a mechanism that makes leaving costly: contribution is a condition of
*use* and stops when use stops.

**Detection and disclosure are separate aggregates**
([ADR 0005](../adr/0005-strain-evidence-detection-internal.md)). Detection reads the
internal aggregate at fine granularity, because a detector reading the published feed would
declare minutes after onset and forfeit the sub-second insertion the mechanism exists to
provide. Disclosure reads only the contract-bound aggregate. The hazard this creates —
a customer-facing surface reading the internal one — is a privacy failure no output-sampling
test catches, so the guard is **structural**: what is enforced is that the wire between the
two does not exist, and a wire fails the build rather than a review.

**There is no pollable strain surface.** A correlation attack needs a time series, and a
time series needs an endpoint. Cohort-derived values are disclosed only as a snapshot
attached to a decision record and never as a queryable resource. This replaces the
publication delay that prior art for a published feed would have required — a provision
recorded as *dropped*, with its reasoning, rather than silently omitted.

**The thresholds are stated and their arithmetic is shown.** No cohort-derived value is
disclosed below **twenty** contributors to a cell — twenty rather than ten precisely because
condition-of-service makes every recipient a contributor, so subtracting one's own
contribution must still leave ten others. Cell keys collapse on disclosure from
`(provider, model, region)` to `(provider, model-family)`, because a sparsely used region is
close to naming its occupants. A customer receives at most one disclosure per cell per
bucket however many workloads they run, or forty workloads reconstruct by repetition what
the minimum exists to prevent. Cohort size and composition are never disclosed at all.

The consequence is a disclosure asymmetry stated to the customer rather than hidden: between
ten contributors and twenty, the behavior runs and the customer learns *that* cohort evidence
moved their routing and what corroborated it — but not how strained the provider is.

## 7. Pricing

The customer-facing promise is **not** "you are billed only during incidents." It is: *you
do not pay for our presence in your request path; you pay for provider risk absorbed.*

The [specification's `Accepted` pricing model](../product-specs/provider-risk-management-gateway.md#pricing-model)
is a flat subscription tiered on **spend under management** — the customer's provider spend
for managed traffic, computed from the connector's reported token counts against a published,
forward-only rate card kept deliberately separate from the capability catalogue. The two
carry the same units and incompatible obligations: a capability floor may abstain and may be
corrected backwards, and a billing rate may do neither. There is no percentage of spend, no
per-request markup, and no per-incident fee.

Three commitments make that model self-consistent, and each removes an incentive rather than
adding a promise:

- **Interception costs nothing beyond the subscription**
  ([ADR 0004](../adr/0004-incidents-included-not-surcharged.md)). The gateway declares the
  window, and a gateway paid by its own declarations cannot be trusted to declare honestly.
  Margin is therefore worst in the month a provider degrades badly. That is accepted.
- **The one place detection touches money runs the other way.** When strain is present and
  the gateway fails to push a directive the connector acknowledges, that period counts
  against control-plane availability and produces a credit. The gateway loses money by
  failing to open a window and gains nothing by opening one — the exact inverse of the
  surcharge that was rejected.
- **Bypass is free in both directions.** Involuntary bypass earns a self-issued credit.
  Voluntary bypass — remove the connector, stop paying — is permitted, and no mechanism
  exists to make it costly, because any such mechanism would make this the always-on
  middleman the non-goals forbid. Retention rests on the connector degrading to a static
  base URL without a live control plane. If that is not enough, the product is wrong, and
  that is to be learned from churn rather than prevented by lock-in.

Reservations follow the same logic: a reservation is customer-held and customer-declared,
the gateway never buys or holds provider capacity, and nothing is reclaimed onto the
gateway's invoice. Holding the reservation would mean that bypassing the gateway forfeits
capacity the customer paid for, which inverts the promise above.

### The rate structure is unresolved, and the drafts disagree

An evaluator should know that this repository currently contains two incompatible pricing
shapes, and that the disagreement is live rather than editorial.

[`pricing-strategy.md`](../product-specs/pricing-strategy.md) is a `Draft` that proposes a
different structure: priced per **connector** with a free allowance and volume discounts,
plus an optional percentage-of-spend path at a proposed 2–3%. That is not the `Accepted`
specification's model, which is tiered on spend under management and explicitly excludes a
percentage of spend.

Nothing in this paper resolves that. Two things narrow it:

- [ADR 0011](../adr/0011-billing-unit-is-the-managed-workload.md) (*proposed*) settles what
  is being counted, though not the rate: the billing unit is the managed **workload**, and
  the word *connector* is retired from pricing language entirely. An architectural connector
  is a process; a customer running one service across twelve autoscaled replicas runs twelve
  of them and would be billed twelve times for one integration, on a number our
  infrastructure decides rather than they do.
- The draft records, in its own Constraints, that no infra cost or capacity sizing exists
  for this product, so every rate in it is derived from competitor comparison rather than
  from measured cost.

The rate structure and its rates are therefore an open decision (#22), and the honest
summary is that no number in the draft came from a customer or from our own measured
infrastructure cost.

## 8. Evidence, and what it does not establish

The proof artifacts are commands rather than prose, and they are listed with what each
proves in the specification's
[Delivery evidence](../product-specs/provider-risk-management-gateway.md#delivery-evidence)
section. The two worth running yourself:

```bash
npm --prefix gateway run e2e
```

```bash
npm --prefix gateway run load
```

The first drives seven end-to-end checks, including *no chat-completion request appears in
the gateway's access log at all*, a target switch reaching the connector within five seconds
with its acknowledgement recorded, the sample application surviving the gateway being
killed, and `unmet` reached on connector reports alone with zero in-path requests. The
second fails — exits non-zero — if setting a target does not move the traffic split, which
is the point: an artifact that cannot fail is not evidence. It has caught two real defects
the unit suite, green throughout, could not see.

What is proven: all six behavior-1 criteria, the three connector criteria, the behavior-4
reservation criterion, and the fail-open boundary. Behaviors 2, 3 and 5 are unclaimed, on
stated triggers rather than on a schedule.

What the evidence does **not** establish, and no reader should infer:

- **Every run is against stub providers on localhost.** No deployment, no cloud account. The
  capability catalogue's realistic-looking floors are plausible numbers, not measurements.
  One opt-in, credential-gated command has reached a real provider and gotten a real
  response; it is a smoke test, and **no capability floor has ever been measured.**
- **`success_rate` is measured and honored but never driven to breach** by any verification
  artifact. The two dimensions with named artifacts are `p95_ms` and
  `cost_per_1k_tokens_usd`.
- **The connector contributes strain evidence but aggregates and discloses nothing**, so no
  behavior-3 criterion is claimed.
- **No pricing-model criterion is claimed.** The availability credit, invoice invariance, and
  window records all depend on behavior 2.
- **CI runs and is green but cannot be made required** on this repository's plan, so a red
  run does not block a merge.
- **A known defect is open:** a non-default customer's usage reports corrupt the default
  customer's status, demonstrated by an end-to-end check today. It must be fixed before
  multi-tenancy.

## 9. What an evaluator should decide

Seven questions cannot be answered from the code. Each has an argument already in progress,
linked from
[the handoff index's *Decisions still open*](index.md#decisions-still-open); they are named
here in the order in which one answer changes another.

1. **Is soft-budget-by-default viable?** If most of the market needs hard budget, the central
   architectural bet is wrong, and every other question changes shape.
2. **Do we pursue in-path mode alongside the out-of-path connector?** It decides whether
   hard budget, compliance-constrained buyers, and teams without call-site control are
   addressable at any price.
3. **Do we take custody of provider credentials to reduce onboarding friction?** It trades
   real liability — a credential vault whose value is unrelated to our size — for
   convenience, and it decides what class of company this is.
4. **Which rate structure, and which rates?** See section 7. No number came from a customer
   or from measured cost.
5. **What is the infra cost and capacity profile of the push model?** Held-open SSE sockets
   per connector are cheap, but "cheap" has never been quantified here, and every
   cost-grounded rate waits on it.
6. **Does this ship standalone, fold into `Gateway-LLM` as its routing layer, or run as one
   policy core with two hosts?** See [the comparison](gateway-llm-comparison.md);
   `Gateway-LLM` is acquiring every part of this product except target-state routing.
7. **What is the productionization sequence?** Multi-quarter, and its first phase is a
   design partner, which costs almost nothing.

The paper's own recommendation is narrow: question 1 is cheap to answer and expensive to be
wrong about, and it gates the rest. It needs conversations with buyers, not code.
