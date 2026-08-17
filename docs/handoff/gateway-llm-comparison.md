# henry-ai-router compared with Gateway-LLM

- Written: 2026-08-17
- Compares: this repository at `a3d89cb` on `docs-handoff-package-and-three-adrs`
- Against: [`Uniblock-dev/Gateway-LLM`](https://github.com/Uniblock-dev/Gateway-LLM) at `main`,
  read 2026-08-17 — `START-HERE.md`, `AGENTS.md`, the PRD
  (`_bmad-output/product/prds/prd-Gateway-LLM-2026-08-14/prd.md`, 54 requirements), the
  architecture spine (`ARCHITECTURE-SPINE.md`, 22 invariants `AD-1`…`AD-22`),
  `_bmad-output/product/epics.md` (12 epics, ~180 stories),
  `_bmad-output/build/sprint-status.yaml`, and the 2026-08-16 handoff logs
- Extends: [#20](https://github.com/hoomji/henry-ai-router/issues/20), which compared this
  repository against the blockchain stack
- The standalone case for this repository, which this document weighs against folding it in:
  [`white-paper.md`](white-paper.md). Its section 5 is the honest half — the four things the
  out-of-path structure costs — and is the part most relevant to the recommendation below

**This supersedes an earlier draft of this document that compared against
`uniblock-llm-gateway` and the 2026-08-14 LLM Gateway V1 wiki spec.** That comparison is
now wrong in its central claim, and the correction is the first section below, because
anyone who read the earlier version took away a conclusion that no longer holds.

## Correcting the earlier comparison

The earlier draft rested on one line from the 2026-08-14 wiki spec: **V1 is "a router with
no routing."** Its §3.2 cut model fallbacks, retries and "any routing at all," and from that
followed a comfortable conclusion — the two efforts are *sequential, not competing*, one
building the access and money plane and the other the risk and routing plane.

Gateway-LLM is not that product. Five things changed between the wiki spec and the code:

| Wiki spec, 2026-08-14 | Gateway-LLM, today |
|---|---|
| No routing, no fallback | **FR-7: fallback is in V1** — a second provider on 5xx, 429, 529, connection error, or no first byte in 10 seconds, at most two attempts. Plus **health-aware provider ordering** (Stories 2.13 and 6.6): the healthy provider is tried first |
| Streaming out of V1 | **FR-3 and NFR-4: streaming is in V1**, and must not truncate at 100 concurrent streams |
| Base is Portkey as a read-only reference | `services/gateway` is a **permanent hard fork of Portkey**, vendored, 78 provider adapters |
| Prompt and response bodies never stored | **Epic 7: capture ships as a paid, opt-in, per-key add-on**, encrypted per account, 30-day expiry |
| Two-week box: V1 by 2026-08-28, demo 2026-09-01 | **No date at all.** Primary goal is 3 paying customers, "no target date"; the PRD says the 90-day deadline "was the only pressure keeping V1 small, and it has been removed rather than the scope cut" |

So the earlier document's core finding is void. The correct finding is less comfortable:
**the overlap is substantial and growing in this repository's direction.**

## What each one is

| | `henry-ai-router` | `Gateway-LLM` |
|---|---|---|
| Thesis | Provider risk management: hold a customer-stated target | One key, one bill, every model; 2.5% platform fee on served requests |
| Paradigm | Control plane / data plane split | **Control plane / data plane split** — same words, `AD-1` |
| Where the control plane sits | **Out of the request path.** It pushes ranked lists; the connector calls providers | **In the request path.** The customer SDK hits the control plane, which authenticates, reserves money, injects the provider credential and forwards to the gateway |
| Routing | Target-state: ranked list computed to hold `p95_ms`, `cost_per_1k_tokens_usd` or `success_rate` | Failure-triggered fallback plus health-aware ordering. **No customer-stated target exists** |
| Provider credentials | Customer's own, never reach the gateway | Uniblock-held, ciphertext everywhere but memory (`AD-5`), exchanged in the control plane (`AD-6`) |
| Budget | Async, connector-side, bounded overspend (ADR 0008) | **Synchronous hard budget**: reserve-then-settle (`AD-3`), refuse at zero, and FR-20 terminates a request already in flight |
| Money | None. No billing code exists | Integer minor units, basis points, one pricing function and one rounding rule (`AD-13`), Stripe, idempotent grants (`AD-8`) |
| Multi-tenancy | One known defect: a non-default customer corrupts the default customer's status | Accounts, workspaces, members, roles, invitations, a permission matrix the build checks (`FR-53`, `FR-54`) |
| Platform | TypeScript on Node 24, zero runtime deps, **nothing deployed** | Cloudflare Workers, D1, KV, Durable Objects, Hono, Drizzle, Better Auth |
| Plan vs code | 2 of 5 behaviors built, both proven by commands | 12 epics, ~180 stories, 54 requirements, 22 invariants; Epic 0 done, Epics 1, 2 and 9 partly, most of the rest `backlog` |
| Verification | CI on every push, a gate proven to fail, 240 tests, an e2e run proving the central claim | 202 control-plane tests, clean typecheck — and **"No CI exists. Nothing runs unless you run it."** |

## Where they now genuinely collide

Four overlaps, in increasing order of how much they should worry this repository.

### 1. Provider health measurement — same window, same shape, different consumer

`FR-34` marks a provider unhealthy when, over a **rolling 5-minute window**, its error rate
exceeds 5% or its p95 latency exceeds three times its 7-day median, visible within a minute.
`AD-7` writes observations to a per-provider Durable Object and reads a KV projection on the
request path. Story 6.6 switches on health-aware ordering: of two providers for one model,
the healthy one is tried first.

This repository measures a **trailing 5 minutes or 200 requests, whichever spans longer**,
per provider, and ranks on it. The mechanisms are near-identical and were derived
independently.

The difference is what the measurement is *for*. Gateway-LLM's health is an operational
state: it protects the platform and surfaces on a staff screen. This repository's window is
a customer-facing commitment: it decides whether a stated target is being held, and it owes
the customer a *binding reason* naming why each candidate provider was not selected. Same
data, one is telemetry and the other is a promise.

### 2. Hard budget already exists, in path, as somebody else's Epic 4

ADR [0008](../adr/0008-budget-enforcement-is-async-connector-side-by-default.md) treats
synchronous, zero-overrun denial as a hypothetical opt-in tier that would need its own
path-entry design, and [#21](https://github.com/hoomji/henry-ai-router/issues/21) asks
whether the market needs it. ADR
[0009](../adr/0009-in-path-mode-is-a-gateway-operated-connector.md) then argues it is the
same mechanism as in-path mode.

Gateway-LLM has built the design. `AD-3` reserves an estimated maximum before calling the
provider and settles the actual cost after, with a 10-minute expiry on a stranded
reservation. `AD-2` puts one Durable Object per account in front of every balance read and
write so two concurrent requests cannot both pass a check-then-deduct. `FR-20` refuses at
zero balance *and terminates a request already in flight*, accepting that the provider still
bills for tokens generated before the cutoff — a trade recorded in the requirement itself.

**This changes what #21 and #23 are asking.** The question is no longer "should we build
hard budget?" but "should we build a second one?" And it makes ADR 0009's recommendation
concrete: the in-path host it needs is a Worker that already reserves money, holds
credentials and forwards to a router.

### 3. Upstream capacity is provider risk management, arrived at from the other side

Epic 10 and invariants `AD-18` through `AD-22` are the largest single body of thinking in
that repository, and they exist because "three independent audits of the plan found that no
component anywhere stored, read or checked what a provider will actually sell us."

What they built: capacity as a **counter** identified by eight things, superseded rather
than updated so last Tuesday's usage is explainable against last Tuesday's limit
(`AD-18`); limits expressed in the provider's own units and windows, spent as a vector
applied all-or-nothing (`AD-19`); sharded pool counters because one object caps the platform
near 1,000 rps (`AD-20`); one function admitting allocations so a thousand customers cannot
each pass an isolated check and together promise more than is held (`AD-21`); and three
distinct refusal codes so a customer can tell *their* limit from *our* protection from *the
provider's* refusal (`AD-22`).

That is provider risk management. It is aimed at the platform's own exposure rather than at
a customer's stated outcome, and it is expressed as capacity accounting rather than as
routing — but a reader of this repository's specification will recognise most of it.

Two smaller notes, both in this repository's favour:

- `AD-22` holds that a provider 429 feeds capacity state and **never** the health error
  rate, "because being out of room for us and being broken want opposite responses." This
  specification independently holds that a 429 the gateway re-routed is not counted as a
  failure, and that a 429 attributable to a customer's own quota is not strain. Two teams
  reaching the same distinction is the strongest evidence either has that it is real.
- Gateway-LLM's shared provider accounts mean it has, by construction, the **cross-customer
  aggregate that behavior 3 is deferred waiting for.** This specification defers collective
  fatigue-aware routing on roughly ten concurrently connected customers per
  `(provider, model, region)` cell. Inside one shared pool that trigger is met on the day
  the second customer arrives. The privacy contract behavior 3 spends most of its length on
  exists because the evidence crosses a trust boundary; inside a single operator's own pool
  it does not.

### 4. "Workspace" is taken, and it means something else

ADR [0011](../adr/0011-billing-unit-is-the-managed-workload.md) makes the billing unit the
managed **workload** — a customer-named class of traffic carrying a target.

Gateway-LLM's `FR-38` and `AD-17` make **workspace** a first-class concept: it scopes API
keys, usage records, the playground and a spend limit, it holds members with roles, and it
is explicitly *not* where money lives — "the account plane governs money, the workspace
plane governs authority to spend."

A customer of both products would hold workspaces (authority to spend, with members) and
workloads (classes of traffic, with targets), and the two are not the same partition of
anything. That is survivable if stated, and a support conversation if not. Note also that
`FR-38` already gives a workspace a spend limit, which is per-workspace budget enforcement —
so the unit ADR 0011 chose for billing is a unit the sibling product already meters.

## What is genuinely still only here

Stripped of the overlaps, this is what does not exist anywhere in Gateway-LLM's 54
requirements or 22 invariants:

1. **A customer-stated target.** Nothing in that repository lets a customer say "hold p95
   under 400 ms" or "keep cost per 1k tokens under $X" and have routing serve it. Fallback is
   failure-triggered; health ordering is operational. The customer names a model and gets it.
2. **Declaration-time infeasibility.** Rejecting an impossible target when it is written,
   against a provenance-tiered capability floor that abstains when its sources go stale, with
   a rejection that discloses its own basis so the customer can dispute it.
3. **`unmet` as a customer-facing state**, with two-window hysteresis in both directions and
   a per-candidate reason for every provider not selected.
4. **The out-of-path architecture itself**, and everything downstream of it: no added
   latency, no single point of failure, no credential custody, and a product that is free to
   leave because bypass costs the customer nothing.
5. **Reservation-aware routing.** Customer-held provisioned capacity (Bedrock PT, Azure PTU)
   surfaced when traffic is not addressing it. Gateway-LLM's allocations are the inverse
   relationship — capacity *we* hold and sell.

Items 1 to 3 are one thing: **target-state routing is the wedge, and it is the whole wedge.**
Items 4 and 5 are architectural consequences and a second behavior.

## The strategic question this forces

The earlier draft asked whether to build in-path mode here. That question is now downstream
of a larger one.

Gateway-LLM is acquiring, with a team and a deployed platform, every part of this product
*except* target-state routing: provider health measurement, fallback, ranked ordering,
capacity management, spend limits, per-request metering, a dashboard, multi-tenancy, and
billing. It is doing so in-path, where it also has ground truth this architecture
deliberately gives up.

Three honest options, and the recommendation is the second:

**A. Stay standalone.** Defensible only if the out-of-path property is itself the product —
if customers buy "never in your path, never holding your keys" as a primary reason. Nobody
has tested that. `NFR-1` gives the number it has to beat: Gateway-LLM budgets **under 50 ms
p95 of added latency**, and if it holds that, "no added latency" is worth 50 ms rather than
worth an architecture.

**B. Become the target-state routing layer inside Gateway-LLM.** The seam is clean and
already exists. `AD-6` has the control plane resolve a model to a provider before forwarding;
that resolution is exactly where a ranked list would be consumed, and `AD-1`'s one-way
dependency rule means the policy would sit in the control plane where this repository's
`computeRankedList` already belongs. The target document, the feasibility check and the
`unmet` machine are portable as-is because none of them touches the data path. What this
repository loses is the out-of-path bet; what it gains is a platform, a team, real traffic,
and a measurement window fed by ground truth rather than by self-reported usage.

**C. Keep both, one policy core, two hosts.** ADR 0009's shape, with Gateway-LLM as the
in-path host. Strictly more work than B and it only pays if option A's customer exists.

Whichever is chosen, one thing should happen this week regardless, because it is cheap and
it expires: **the health and capacity work in Epics 6 and 10 should be reviewed against this
repository's specification before it is built.** Sections
[How each dimension is measured](../product-specs/provider-risk-management-gateway.md#how-each-dimension-is-measured)
and [What declares a window's
start](../product-specs/provider-risk-management-gateway.md#what-declares-a-windows-start)
resolve questions those epics will meet — why a re-routed 429 must not count as a failure,
why thresholds must be banded against a provider's own trailing baseline rather than set
absolutely, and why a routing decision that cannot state its binding reason should not be
made. Those cost nothing to read now and are expensive to retrofit after a schema lands.

## The objection that was raised inside Uniblock, and then withdrawn

The strongest substantive challenge to this product's thesis came from the 2026-08-14 room,
and it is worth answering even though the team that raised it no longer holds the line.

Paraphrasing the positions on record: a JSON-RPC answer is provider-independent, so falling
back is free — the price of Bitcoin is the same whoever serves it. A model answer is not.
Routing to a different model produces different output and can break the calling system, even
between same-tier models, and the great majority of real usage names exactly the model it
wants. The conclusion drawn was that there should be **no fallback at all** for a named-model
request.

Two things follow, and they point in opposite directions.

**The objection did not survive its own team's plan.** `FR-7` ships fallback to an alternative
provider for the same model, and Stories 2.13 and 6.6 ship health-aware ordering so the
healthy provider is tried first. So the argument, as applied, was narrower than it sounded: it
was against substituting a *different model*, not against moving between *providers of the
same model*.

**That narrower version is also this repository's answer, and it was already the design.**
`allowed_models` is a required, non-empty list, and listing several models is the customer's
own assertion that they are interchangeable *for that workload*. The gateway routes only
inside the blast radius the customer drew, never adapts a prompt when moving between two
models they listed, and a customer who does not want a model's output removes it. Prompt
translation exists for cross-model failover during an interception window, not for ordinary
routing. And the common case is the *same* model on a different host, where the output concern
largely disappears and the measured spread was 86% in p50 latency on a single day.

The residual risk is unchanged by any of this: **no customer has ever declared an
`allowed_models` list**, so the interchangeability assertion the whole answer rests on has
never been made by anyone outside this repository.

## What each repository could take from the other, today

**`henry-ai-router` → Gateway-LLM**

- **The evidence pattern.** `npm --prefix gateway run load` exits non-zero unless the traffic
  split moves with the target; the repository gate has been demonstrated to fail, not only to
  pass. Gateway-LLM's `NFR-1` (under 50 ms p95 added latency) and `FR-23` (usage reconciles
  exactly with the balance) are precisely the claims that want an artifact which can fail, and
  its own `START-HERE.md` says "tests before claiming" for the same reason.
- **CI.** `AGENTS.md` there states plainly that no CI exists and nothing runs unless a person
  runs it, against 202 tests and a plan of 180 stories. This repository's
  `.github/workflows/gate.yml` calls `scripts/check.py` rather than restating its steps, so CI
  and a local run cannot disagree about what passed. That is a half-day of work there.
- **The 429 and threshold distinctions** named in the previous section, before Epic 6 or 10
  freezes a schema.

**Gateway-LLM → `henry-ai-router`**

- **The money discipline, wholesale.** Integer minor units and integer basis points
  everywhere including in JSON, with a test that fails the build if a `REAL` column appears on
  a money table. One pricing function with one rounding rule applied as the final step
  (`AD-13`). Effective-dated rows so a price change cannot re-price a settled request. This
  repository has no billing code and will need all of it; ADR 0011's Consequences already
  gesture at the rate-card version of the same rule.
- **Reserve-then-settle** (`AD-3`) as the shape for budget, which is what ADR 0008 is
  reasoning toward from the other direction.
- **A permission matrix the build checks.** `FR-54` fails the build when the route table and
  the capability matrix disagree, "because the way a permission check gets lost is not malice,
  it is a route added on a Friday." That is the mechanical enforcement this repository's
  [core beliefs](../design-docs/core-beliefs.md) argue for and the harness report holds
  Governance at level 1 for lacking.
- **`AD-16`, and the finding under it.** Several provider adapters interpolate provider
  options directly into a hostname, so one unstripped header exfiltrates a credential. Any
  in-path mode built here inherits that class of defect on day one.

## One thing the team should know about that repository

Its own 2026-08-16 handoff records that **a live Worker is deployed on the production name
and nobody knew**: `uniblock-control-plane` answers at a `workers.dev` hostname with the
development D1 and KV bound, while the service's README states that staging and production
"neither has ever been deployed." The handoff calls that sentence false and the single most
actionable item in it.

That is not a criticism to carry into a meeting — it was found and written down, which is the
system working. It is a reason to take seriously how much of this repository's own case rests
on the same discipline: a documentation audit that exists because documentation can pass every
check while being false, and a gate that has been proven to fail. The two repositories'
strongest shared asset is that both write down what is not true yet.
