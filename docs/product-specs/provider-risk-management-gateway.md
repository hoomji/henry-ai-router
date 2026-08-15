# Provider risk management gateway

- State: `Draft`
- Owner: henry.tran@uniblock.dev
- Reviewed: 2026-08-14
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
intervenes only when needed, keeps behavior consistent across models, and stops billing
for capacity nobody is using. The observable difference is fewer provider-caused
incidents reaching the customer, and a bill that tracks value delivered rather than
middleman presence.

## Required behavior

The five candidate behaviors below originate from the idea record. Their relative
priority is an open product decision (see table); the specification records what each
must do if built.

1. **Target-state routing.** The customer states an outcome instead of a routing rule;
   the gateway continuously adjusts the provider mix to hold that outcome proactively
   rather than reacting after a breach. This behavior is specified in full in
   [Target-state routing in detail](#target-state-routing-in-detail) below.
2. **Incident-only routing.** During normal operation the gateway is bypassed and does
   not sit in the request path as a chargeable middleman; it intercepts traffic — and
   charges — only while a detected incident is in progress (rate-limit storm, provider
   outage, model deprecation).
3. **Collective fatigue-aware routing.** The gateway shares anonymized provider-strain
   signals (rate-limit pressure, error rates) across its whole customer base, so routing
   shifts away from a strained provider before any individual customer receives a 429.
4. **Usage-decay pricing.** Reserved provider capacity that a customer pre-provisioned
   but is not using is priced or reclaimed, instead of billing only per-call or
   per-token while idle reservations sit wasted.
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
  all, because it bounds the set of candidates.

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

**`infeasible_by_declaration`** — no allowed provider *can* satisfy the target, knowable
before any traffic flows. Checked synchronously when the target document is written; the
write is rejected. The customer cannot deploy an impossible target.

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

Target state is deliberately **not** reported on the bill; entangling behavior 1 with
billing would couple it to the pricing decisions that remain open.

### Relaxation

When no mix satisfies every ceiling, the lowest-priority ceiling yields first, and the
gateway reports `unmet` for it. A dimension marked hard never yields: the request fails
instead. Customers who declare no priority and no hard dimension still get deterministic,
explainable behavior from the defaults above rather than gateway discretion — the point
of this behavior is that the gateway's choices are predictable without a routing rule.

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
  customers can audit exactly which traffic was intercepted and charged.
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
- Pricing behaviors (2 and 4) directly shape the business model and must be reversible in
  rollout: pilotable with a subset of customers before general availability.

## Acceptance criteria

- [ ] A customer can state a per-workload target over `p95_ms`,
      `cost_per_1k_tokens_usd`, and `success_rate` and observe the gateway change provider
      mix in response to drifting provider performance without a routing rule (behavior 1).
- [ ] A target no allowed provider can satisfy is rejected when written, with a report
      naming the dimension, the requested value, and the best achievable value and the
      provider achieving it (behavior 1, `infeasible_by_declaration`).
- [ ] A target that stops holding at runtime raises `unmet` after two consecutive missed
      windows and clears after two consecutive held windows, visible on the status
      resource, the notification, and the response header, with a per-provider reason for
      each rejected candidate (behavior 1, `unmet`).
- [ ] When ceilings conflict, the lowest-priority ceiling yields and is reported; a
      dimension marked hard fails the request instead of being breached (behavior 1).
- [ ] Traffic outside a declared incident window reaches the provider without gateway
      interception or gateway charges; traffic inside one is intercepted, and both window
      edges are visible to the customer (behavior 2).
- [ ] When one customer's traffic strains a provider, another customer's routing shifts
      away from that provider before receiving a rate-limit error, with no
      customer-identifying data exposed (behavior 3).
- [ ] Idle reserved capacity is visibly priced or reclaimed on the customer's bill or
      dashboard rather than silently held (behavior 4).
- [ ] A prompt authored for model A, routed to model B, produces the intended behavior on
      model B or an explicit fallback notice — never a silent semantic change (behavior 5).
- [ ] With the gateway down, customer traffic still reaches the configured provider
      (fail-open boundary).

## Open product decisions

| Question | Blocking | Owner | Resolution |
|---|---|---|---|
| Which of the five behaviors is the initial wedge to build first? | Yes — blocks any ExecPlan milestone ordering | henry.tran@uniblock.dev | Open |
| Is incident-only pricing (behavior 2) compatible with usage-decay pricing (behavior 4) in one business model? | No | henry.tran@uniblock.dev | Open |
| Can a customer target a **monthly cost budget** rather than a unit rate? | No — behavior 1 ships with the unit rate | henry.tran@uniblock.dev | Deferred ([#6](https://github.com/hoomji/henry-ai-router/issues/6)). A unit rate is decidable from a state snapshot; a budget requires persistent spend accounting and an exhaustion policy (hard-stop, degrade, or notify), turning provider state from a snapshot into a ledger. Specify as its own behavior if wanted. |
| Should **error rate** be targetable separately from `success_rate`? | No | henry.tran@uniblock.dev | Deferred ([#6](https://github.com/hoomji/henry-ai-router/issues/6)). For a router the two collapse: a 429 the gateway re-routed is not a customer-visible error. Revisit only if a customer needs to see provider-level error pressure they are shielded from. |
| Should **throughput / rate-limit headroom** be targetable? | No | henry.tran@uniblock.dev | Deferred ([#6](https://github.com/hoomji/henry-ai-router/issues/6)). Headroom is the signal behavior 3 shares across customers, not an outcome an individual customer states. Revisit when behavior 3 is specified. |

## Delivery evidence

Not delivered. This repository currently contains no implementation; this specification
promotes the idea record to required product behavior for a future implementation.
