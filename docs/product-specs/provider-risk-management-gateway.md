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

1. **Target-state routing.** The customer states an outcome (for example "p95 latency
   under 400 ms and monthly cost under $Y") instead of a routing rule; the gateway
   continuously adjusts the provider mix to hold that target proactively rather than
   reacting after a breach.
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

## Boundaries and failure behavior

- If the gateway itself is unavailable, customer traffic must still flow directly to the
  customer's configured provider (fail-open); the gateway must never become a worse
  single point of failure than the providers it manages.
- A stated target (behavior 1) that is infeasible — no provider mix can satisfy it — must
  be reported to the customer as infeasible, not silently best-effort.
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

- [ ] A customer can state a latency/cost target and observe the gateway change provider
      mix in response to drifting provider performance without a routing rule (behavior 1).
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

## Delivery evidence

Not delivered. This repository currently contains no implementation; this specification
promotes the idea record to required product behavior for a future implementation.
