# Provider risk management gateway

- State: `Draft`
- Owner: henry.tran@uniblock.dev
- Reviewed: 2026-08-15
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
fewer provider-caused incidents reaching the customer, and a bill that tracks risk
absorbed rather than middleman presence.

## Required behavior

The five candidate behaviors below originate from the idea record. Their relative
priority is an open product decision (see table); the specification records what each
must do if built.

1. **Target-state routing.** The customer states an outcome instead of a routing rule;
   the gateway continuously adjusts the provider mix to hold that outcome proactively
   rather than reacting after a breach. This behavior is specified in full in
   [Target-state routing in detail](#target-state-routing-in-detail) below.
2. **Incident-only interception.** The gateway is absent from the request path in normal
   operation and takes the data path only while a declared incident is in progress
   (rate-limit storm, provider outage, model deprecation). Both edges of that window are
   auditable. Interception carries **no incremental charge**: what the customer pays does
   not depend on whether an incident was declared (see
   [Pricing model](#pricing-model)).
3. **Collective fatigue-aware routing.** The gateway shares anonymized provider-strain
   signals (rate-limit pressure, error rates) across its whole customer base, so routing
   shifts away from a strained provider before any individual customer receives a 429.
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
   correlate an individual slow request with a known state.

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
for traffic the gateway manages, computed from the client's reported token counts against
a published **rate card**. There is no percentage of spend, no per-request markup, and no
per-incident fee.

The rate card is a versioned artifact distinct from the *capability catalogue*. The two
carry the same units and incompatible obligations: a capability floor is an optimistic
claim about what a provider can do, is permitted to *abstain* when its sources go stale
([ADR 0003](../adr/0003-provenance-tiered-capability-catalogue.md)), and is corrected
backwards when it turns out wrong. A billing rate may do none of those things. The rate
card may be derived from the catalogue on a slow cadence, but it changes only forward and
a floor correction never restates a settled invoice.

Token counts are reported by the customer's own client. That is accepted rather than
audited: the code that reports usage is the code that receives the routing benefit, so
under-reporting degrades the customer's own provider mix.

### What an incident costs

Nothing beyond the subscription. The gateway declares the incident window
([#9](https://github.com/hoomji/henry-ai-router/issues/9)), and a gateway paid by its own
declarations cannot be trusted to make them honestly. Incident cost is priced into the
tier, not recovered from it; margin is therefore worst in the month a provider degrades
badly, which is accepted. Recorded in
[ADR 0004](../adr/0004-incidents-included-not-surcharged.md).

### What a bypassed customer owes

Bypass is free, in both of its forms, and this is deliberate.

- **Involuntary** (the gateway is unavailable, fail-open fires): the customer is owed a
  credit against **control-plane availability** — whether the gateway can serve the status
  resource and push a routing directive a client acknowledges. Never against request
  success, which belongs to the provider and which fail-open exists to preserve. Because
  the gateway is out of the path, a control-plane outage is not observable to the
  customer: their traffic continues to the last-directed provider. The credit is therefore
  **self-issued from the gateway's own measurement**. A credit only the vendor can detect
  is either a written commitment or nothing at all.
- **Voluntary** (the customer removes the client and stops paying): permitted, and no
  mechanism exists to make it costly. Any such mechanism would make the gateway the
  always-on middleman the non-goals forbid. Retention rests on the client degrading to a
  static base URL without a live control plane — no mix, no feasibility check, no strain
  signal, no incident escalation. If that is not enough, the product is wrong, and that is
  to be learned from churn rather than prevented by lock-in.

### Reservations

A reservation is **customer-held and customer-declared**. The gateway never buys, holds,
or resells provider capacity: if the gateway held the reservation, bypassing the gateway
would forfeit capacity the customer paid for, which inverts the promise above and would
make this a capacity-broker business carrying provider commitments on its own books.

The customer declares each reservation (host, model, size, term, effective rate).
Utilization is computed from the client's own telemetry rather than from the provider,
because the authoritative provider signals do not serve routing: Azure publishes
`Provisioned-managed Utilization V2` but Azure Monitor lags 30 seconds to 15 minutes,
against a 5-minute measurement window, and Bedrock publishes no utilization figure at all.
A read-only cloud credential may be offered as optional corroboration; it is never
required, because that grant is a far heavier install than the client the gateway already
needs.

Nothing is reclaimed and nothing appears on the gateway's invoice — the reservation is a
contract between the customer and their provider. What the gateway owes is visibility and
routing: the most common cause of an idle reservation is a call site that never addresses
it (on Bedrock, passing the foundation-model ID instead of the `provisionedModelArn`), and
that is visible at the call site where the client already sits.

A declared reservation makes `cost_per_1k_tokens_usd` **customer-specific**, which the
capability catalogue's global `(model, host, region, service_tier)` key does not currently
express. Reconciling that is
[#12](https://github.com/hoomji/henry-ai-router/issues/12)'s.

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
- Incident detection (behavior 2) must declare incident start and end explicitly so
  customers can audit exactly which traffic was intercepted. The window is an audit
  boundary, not a billing boundary: no charge depends on it.
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

- The gateway's value proposition depends on the network effect of shared strain signals
  (behavior 3); the design must not require per-tenant data silos that prevent it.
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
  middleman the non-goals exclude.

## Acceptance criteria

- [ ] A customer can state a per-workload target over `p95_ms`,
      `cost_per_1k_tokens_usd`, and `success_rate` and observe the gateway change provider
      mix in response to drifting provider performance without a routing rule (behavior 1).
- [ ] A target no allowed provider can satisfy is rejected when written, with a report
      naming the dimension, the requested value, the best achievable value and the
      provider achieving it, and the provenance and age of the capability floor the
      rejection rests on (behavior 1, `infeasible_by_declaration`).
- [ ] A target whose candidate capability floors have all gone stale is accepted rather
      than rejected, and the abstention is observable (behavior 1).
- [ ] A capability floor correction leaves every existing target document valid and in
      force, flags the affected workloads on the status resource, and notifies only a
      workload already `unmet` on the corrected dimension (behavior 1).
- [ ] A target that stops holding at runtime raises `unmet` after two consecutive missed
      windows and clears after two consecutive held windows, visible on the status
      resource, the notification, and the response header, with a per-provider reason for
      each rejected candidate (behavior 1, `unmet`).
- [ ] When ceilings conflict, the lowest-priority ceiling yields and is reported; a
      dimension marked hard fails the request instead of being breached (behavior 1).
- [ ] Traffic outside a declared incident window reaches the provider without gateway
      interception; traffic inside one is intercepted, and both window edges are visible
      to the customer (behavior 2).
- [ ] Two customers with identical traffic and different incident histories receive
      identical invoices; no invoice line varies with whether an incident was declared
      (behavior 2, pricing model).
- [ ] A period in which the gateway could not serve the status resource or push a routing
      directive produces a credit the customer did not have to ask for (pricing model).
- [ ] When one customer's traffic strains a provider, another customer's routing shifts
      away from that provider before receiving a rate-limit error, with no
      customer-identifying data exposed (behavior 3).
- [ ] A declared reservation that traffic is not addressing is surfaced to the customer,
      and eligible traffic is subsequently routed onto it ahead of on-demand capacity,
      with no provider credential granted to the gateway (behavior 4).
- [ ] A prompt authored for model A, routed to model B, produces the intended behavior on
      model B or an explicit fallback notice — never a silent semantic change (behavior 5).
- [ ] With the gateway down, customer traffic still reaches the configured provider
      (fail-open boundary).

## Open product decisions

| Question | Blocking | Owner | Resolution |
|---|---|---|---|
| Which of the five behaviors is the initial wedge to build first? | Yes — blocks any ExecPlan milestone ordering | henry.tran@uniblock.dev | Open |
| Is incident-only pricing (behavior 2) compatible with usage-decay pricing (behavior 4) in one business model? | No | henry.tran@uniblock.dev | Resolved ([#7](https://github.com/hoomji/henry-ai-router/issues/7)). Yes — because neither survives as a business model once its terms are separated. Behavior 2 fused "out of the path" with "charged only during incidents"; the first is kept, the second is dropped, because the gateway declares the incident window and must not be paid by its own declarations ([ADR 0004](../adr/0004-incidents-included-not-surcharged.md)). Behavior 4 loses custody and becomes *reservation-aware routing*, a routing input rather than a price. What remains is one model: a flat subscription tiered on spend under management, computed from client telemetry against a forward-only rate card kept separate from the capability catalogue, with incidents included and bypass free in both directions. Specified in [Pricing model](#pricing-model). |
| Can a customer target a **monthly cost budget** rather than a unit rate? | No — behavior 1 ships with the unit rate | henry.tran@uniblock.dev | Deferred ([#6](https://github.com/hoomji/henry-ai-router/issues/6)). A unit rate is decidable from a state snapshot; a budget requires persistent spend accounting and an exhaustion policy (hard-stop, degrade, or notify), turning provider state from a snapshot into a ledger. Specify as its own behavior if wanted. |
| Should **error rate** be targetable separately from `success_rate`? | No | henry.tran@uniblock.dev | Deferred ([#6](https://github.com/hoomji/henry-ai-router/issues/6)). For a router the two collapse: a 429 the gateway re-routed is not a customer-visible error. Revisit only if a customer needs to see provider-level error pressure they are shielded from. |
| Should a customer be able to see, or set, the confidence the feasibility check needs before it rejects? | No — the margin ships as a fixed rule | henry.tran@uniblock.dev | Open ([#12](https://github.com/hoomji/henry-ai-router/issues/12)). Rejection is biased optimistic with a variance-based margin the customer cannot see or tune. A customer who genuinely wants a strict pre-flight check ("reject unless you are certain") has no way to ask for one, and a customer who wants none has no way to opt out. Revisit once abstention and false-`unmet` rates are observable. |
| Should **throughput / rate-limit headroom** be targetable? | No | henry.tran@uniblock.dev | Deferred ([#6](https://github.com/hoomji/henry-ai-router/issues/6)). Headroom is the signal behavior 3 shares across customers, not an outcome an individual customer states. Revisit when behavior 3 is specified. |

## Delivery evidence

Not delivered. This repository currently contains no implementation; this specification
promotes the idea record to required product behavior for a future implementation.
