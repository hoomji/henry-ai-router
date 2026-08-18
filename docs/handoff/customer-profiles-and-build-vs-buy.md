# Customer profiles and the build-or-buy question

Who buys this product, what each customer states, and why each customer does not build the
same thing.

- Owner: henry.tran@uniblock.dev
- Written: 2026-08-17
- Specification: [`../product-specs/provider-risk-management-gateway.md`](../product-specs/provider-risk-management-gateway.md)
- Language: ASD-STE100 Simplified Technical English. The terms in *italics* are defined in
  [`../../CONTEXT.md`](../../CONTEXT.md).

**This document is not evidence.** No customer, no design partner and no interview exists.
Each profile below is an illustration of the specified behavior. Each profile is a
hypothesis about a buyer. Do not read a profile as a demand from the market. The
[white paper](white-paper.md#8-the-evidence-and-its-limits) states what the evidence proves.

Behaviors 1 and 4 are built. Behaviors 2, 3 and 5 are not. A benefit below that needs an
unbuilt behavior carries a note.

## How the product is used

The customer installs a *connector* in the application. The connector calls each *provider*
directly with the customer's own credential. The gateway sends a *directive* to the
connector. The directive holds a *ranked list* of providers. The connector obeys that list.
On a network error, a status 429 or a status 5xx, the connector tries the next provider in
the list.

The customer writes no routing rule. The customer states a *target* for each *workload*. A
target sets ceilings and floors on three *dimensions*: `p95_ms`,
`cost_per_1k_tokens_usd` and `success_rate`. The target also gives *allowed models*.

## Profile 1: a small company

**Shape.** Six persons. One product. No engineer on call at night.

**What the customer states.** One workload, `default`. A ceiling of `p95_ms = 3000`. The
*objective* is `cost_per_1k_tokens_usd`. The *allowed models* list holds three inexpensive
models.

**The benefit.** A provider gives many errors. The connector moves to the next provider in
the *ranked list* without a person. The cost increases. The product continues.

The *fail-open* property is more important than the routing for a customer of this size.
The gateway is not in the request path. A gateway failure therefore cannot stop the
customer's traffic. The connector keeps the last ranked list and continues. A team of six
persons can accept a control plane with this property. The same team cannot accept a
control plane in the request path.

**The weakness of this profile.** This customer can write the failover rule. It is
approximately 50 lines of code. See [Tier 1](#tier-1-the-customer-can-build-this-today).
This customer has no *reservation* and gets little from a *cohort*. This is the weakest
profile of the three.

## Profile 2: a medium company

**Shape.** Two hundred persons. One business product with three tiers of service.

**What the customer states.** Three workloads with opposite targets.

| Workload | Target |
|---|---|
| `interactive` | A *hard dimension* on `p95_ms`. A short *allowed models* list. |
| `batch-enrichment` | No latency ceiling. The objective is `cost_per_1k_tokens_usd`. |
| `free-tier` | The least expensive group of providers that satisfies the target. |

**The benefit.** Today the team writes this logic three times in the application. The three
copies become different with time. The team replaces three code paths with three targets in
one *target document*.

The gateway checks each target at the time of the write. No allowed model can possibly
satisfy a bad target. The gateway then calls the target *infeasible by declaration* and
refuses the write. The gateway gives the *binding reason*, the best achievable value and
the *provenance* of the *capability floor*. The team learns this immediately. An in-house
version of the same mistake is silent until production.

The *unmet* state gives the team one more benefit. The gateway enters *unmet* after two
missed *windows* and leaves it after two held windows. An alarm on *unmet* tells the team
that the stated outcome is not held. An alarm on latency does not.

## Profile 3: a large company

**Shape.** A bank. Many workloads. Rules of the company control which host serves each
model.

**What the customer states.** Each entry in *allowed models* names a host, for example
`claude-sonnet-4.5@bedrock`. The customer declares each *reservation* in its own resource:
Bedrock Provisioned Throughput and Azure OpenAI PTU.

**The benefit, first part: money.** Some traffic goes to on-demand capacity. The
reservation stays idle. The customer pays two times. The gateway shows the traffic that
does not address the reservation. The gateway then sends eligible traffic to the
reservation first. The gateway never holds the reservation. This is behavior 4 and it is
built.

**The benefit, second part: the host.** The same model on two hosts is not the same
product. On one day the two hosts showed a difference of 86 percent in p50 latency
([#11](https://github.com/hoomji/henry-ai-router/issues/11)). A *capability floor* is
therefore kept for each `(model, host, region, service_tier)` and never for each model. A
customer who must stay on one host needs this granularity.

**The benefit, third part: early movement.** Many customers send a *strain contribution*
into a *cell*. The gateway sees *provider strain* and moves this customer's traffic before
the customer's first status 429. **Behavior 3 is not built.** The connector sends
contributions today. The gateway aggregates nothing and discloses nothing.

## The build-or-buy question

Each profile can build some part of this product. The benefits divide into three tiers. The
three tiers have three different strengths. Do not argue them as one argument.

### Tier 1: the customer can build this today

Failover on a status 429 is approximately 50 lines of code. A competent team writes it in
one afternoon. This tier is not a reason to buy.

The design gives this tier to the customer. Failover on an error is a local rule in the
*connector* at the customer's own call site. It is not a function of the gateway.

**Do not argue this tier.**

### Tier 2: the customer can build this and does not maintain it

This tier holds most of the commercial argument. Each item is possible to build. Each item
decays without continuous work.

- **A *capability floor* with *provenance*.** A person must hold one number for each
  `(model, host, region, service_tier)`, know its source and expire it. In-house this
  becomes a page in a wiki from an earlier month. A stale number fails silently: the team
  ships a target that nothing holds and finds the error in production. The gateway refuses
  the write and gives the reason. When each floor for a candidate is stale, the check
  *abstains* and does not give a number that it cannot support.
- **The measurement discipline.** *Unmet* needs two missed *windows* to enter, two held
  windows to leave, and an explicit *insufficient data* state below the sample floor. An
  in-house version usually has no hysteresis. The alarm then oscillates. The team adds a
  delay, and no person trusts the alarm after that.
- **Continuous re-evaluation of each provider.** An in-house routing rule holds what was
  true on the day of the write. The gateway makes a new *ranked list* continuously from the
  usage reports of the connector. A provider that degraded last month stops receiving
  traffic without a change to the customer's code.

This tier is an argument about maintenance and not about capability. It is true, and each
infrastructure vendor makes it. A team with sufficient time can refuse it correctly.

### Tier 3: the customer cannot build this

**Cross-customer evidence.** One customer's evidence about a provider is that customer's
own traffic. Therefore the earliest possible moment of detection is the moment of the first
failure for that customer. The customer is always late.

*Provider strain* aggregates a *strain contribution* from each connected customer into a
*cell*. The gateway then moves one customer's traffic before that customer sees an error.
No quantity of in-house work gives this result, because the necessary input is the traffic
of other companies.

Two limits apply, and both are important.

- **Behavior 3 is not built.** See the
  [delivery evidence](../product-specs/provider-risk-management-gateway.md#delivery-evidence).
- **The benefit is zero at a small number of customers.** The gateway discloses no
  cohort-derived value below 20 contributors to a cell. An early customer therefore gets a
  cohort that shows nothing. The only benefit that a customer cannot build is also the
  benefit that arrives last.

State this sequence to a reader. Do not imply that the network exists.

## The objection to expect

A careful reader makes this objection: *a bypass is free and the connector degrades to a
static base URL. Therefore I use the product for six months, I learn the correct routing,
and then I keep the 50 lines.*

Nothing prevents this. The specification makes it deliberate. The gateway holds no
reservation, takes no custody of a provider contract, and holds no data that a departing
customer loses. See
[the bypass rules](../product-specs/provider-risk-management-gateway.md#what-a-bypassed-customer-owes).

Two results follow:

- The answer to the build-or-buy question must not use a switching cost. No switching cost
  exists, and none may be added.
- What the customer takes away is a copy of the routing at one moment. It starts to decay
  on the day of departure. This is a tier 2 argument and not a tier 3 argument.

## Summary

| Profile | The primary benefit | The strongest tier |
|---|---|---|
| Small | The team writes no failover, and the gateway cannot stop its traffic | Tier 1 — the customer must probably build this |
| Medium | Three opposite workloads stop being three code paths | Tier 2 |
| Large | The customer stops paying two times for capacity it holds | Tier 2 today, tier 3 after behavior 3 |

Two questions for the reader:

1. Is the tier 2 argument sufficient before behavior 3 exists? Each early customer buys
   maintenance and not a network.
2. Which profile is the design partner? The large profile has the strongest argument today,
   because the *reservation* benefit is a number in a budget and not an engineering opinion.
