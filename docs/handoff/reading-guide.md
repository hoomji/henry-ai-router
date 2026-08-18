# Reading guide: how to walk this proposal

A guided path through the document set in [`index.md`](index.md). Follow it in order and you
will finish able to argue for or against the product on its own terms. Skip around and the
central claim will look either obvious or absurd, because it depends on one unusual fact
that arrives in step 2.

Three paths, depending on how much time you have:

| You have | Do steps | You end up able to |
|---|---|---|
| 10 minutes | 1, 2, 8 | State the bet, and know what `Gateway-LLM` already covers |
| 45 minutes | 1–8 | Argue the product's merits and challenge its evidence |
| Half a day | 1–9 | Review the code and decide the productionization sequence |

Bring a note of every place you disagree. The last step is what to do with those notes.

### Three synthesis documents, and when to use them

Three documents cut across this path rather than sitting inside it. None is authoritative
for any fact — each links to the document that owns it — and all three are written in ASD-STE100
Simplified Technical English using the [`CONTEXT.md`](../../CONTEXT.md) glossary, so they read
flatter than the documents they summarize.

| Document | Use it |
|---|---|
| [`white-paper.md`](white-paper.md) | **Instead of steps 1, 3 and 6** when you have 15 minutes and want the argument end to end: the claim, the mechanism, the four things the mechanism prevents, the price, and what the evidence does not prove. Then come back to step 8, which it does not replace |
| [`../design-docs/technical-blueprint.md`](../design-docs/technical-blueprint.md) | **Before step 9**, or instead of it if you are not reading code. It gives the five control loops, the seven invariants that no single file shows, and the attachment point of each unbuilt behavior |
| [`customer-profiles-and-build-vs-buy.md`](customer-profiles-and-build-vs-buy.md) | **After step 2**, when the question is commercial and not technical: which customer states what, and which benefits the customer can build alone. Read it as hypotheses — no customer and no interview exists |

Read the specification itself, and not the white paper, if you intend to challenge a specific
required behavior. The white paper compresses; the specification is what the product owes a
customer.

---

## Step 1 — The bet, in five minutes

Read [`README.md`](../../README.md).

**What to take from it.** Existing AI routers sell routing rules, a unified schema and
dashboards. The bet here is that the product is the *risk*, not the plumbing: the customer
states a latency ceiling, a cost ceiling or a success-rate floor, and the system holds it by
moving traffic between providers without them ever writing a routing rule.

**What to notice.** The status paragraph is deliberately unflattering — two of five behaviors
built, nothing deployed, one credential-gated command that has ever touched a real provider.
That tone is load-bearing for the rest of the read: where this repository claims something,
it usually names the command that proves it.

**Challenge this.** "Provider risk management" is a category claim. Is it a category, or a
feature of the routers that already exist? The competitive research in step 6 is where that
argument is joined.

## Step 2 — The surprising part

Read [`ARCHITECTURE.md`](../../ARCHITECTURE.md), sections *System boundary* and
*Components and dependency direction*.

**The one fact everything else depends on: in normal operation the gateway is not in the
request path.** The customer's application calls the provider directly, through a small
connector installed at their own call site. The gateway is a control plane — it holds the
target, measures each provider from usage the connector reports back, and pushes ordered
lists of providers over Server-Sent Events. It never carries traffic.

Two consequences do most of the work in every later document:

1. A gateway outage cannot stop customer traffic. The connector keeps calling whichever
   provider it was last told to prefer. The price is that a target change takes about five
   seconds rather than being instant.
2. Because the gateway is out of the path, **connector-reported usage is the only input the
   measurement windows have.** This is the repository's most dangerous property. It broke
   once, invisibly, with every unit test green.

**Challenge this.** The whole product rests on customers installing code in their own
application. That is a heavier ask than changing a base URL — which is exactly what the
`Gateway-LLM` effort asks for instead. Step 8 puts those two side by side.

## Step 3 — What the product must actually do

Read [`docs/product-specs/provider-risk-management-gateway.md`](../product-specs/provider-risk-management-gateway.md).

This is the long document — plan 30 minutes — and it is the proposal. Read it in this order
rather than front to back:

1. **User and problem**, **Outcome**, **Required behavior** (the five behaviors). Five
   minutes, and it frames everything else.
2. **Target-state routing in detail**. Behavior 1, the one that is built. The subsections
   that matter most are *What a customer can target* (the vocabulary is closed at three
   dimensions, deliberately) and *When a target cannot be met* (infeasibility is two states,
   never one).
3. **Pricing model**. A flat subscription tiered on spend under management. No percentage of
   spend, no per-request markup, no per-incident fee. Note *what a bypassed customer owes*:
   nothing, in both directions, on purpose.
4. **Behavior sequence and deferrals**. Why the connector came before any second behavior,
   and why behaviors 3 and 5 are deferred on stated triggers rather than on schedule.
5. **Acceptance criteria** and **Delivery evidence**. Read the checked boxes, then read the
   *What this evidence does not establish* list underneath. That list is the most useful
   paragraph in the repository for someone deciding whether to fund this.
6. **Open product decisions**. The table at the end. Seven rows, each with a resolution or a
   stated reason it is still open.

Skim on a first pass: *Strain-triggered interception in detail* and *Collective strain
signals in detail*. Both specify unbuilt behaviors gated on triggers that are years away at
current customer count. They are there so nobody re-derives them badly later.

**Challenge this.** The spec is unusually complete for a product with no customers. Ask
whether the completeness is a strength (the thinking is done and reviewable) or a warning
sign (a great deal was decided without a single customer conversation). Both readings are
defensible and the answer changes what you fund.

## Step 4 — Where the words come from

Skim [`CONTEXT.md`](../../CONTEXT.md).

Do not read it end to end. Use it when a term in step 3 read oddly — *target*, *workload*,
*ranked list*, *directive*, *cell*, *interception window*, *spend under management*. The
glossary holds no behavior and no decisions, by contract, so it is safe to dip into.

## Step 5 — The decisions and their cost

Read the [ADR table](index.md#decisions), then read these four in full:

- [0006 — routing authority stays gateway-side](../adr/0006-routing-authority-stays-gateway-side.md).
  Why the connector holds exactly one routing rule of its own and no policy. Read its
  *Residual assumption*: a target whose satisfying mix is a *ratio* rather than an ordering
  is not expressible today.
- [0008 — budget enforcement is async and connector-side](../adr/0008-budget-enforcement-is-async-connector-side-by-default.md).
  The first behavior for which the out-of-path bet does not obviously hold. Overspend is
  *bounded*, not eliminated: `report_interval × max_burn_rate`.
- [0009 — in-path mode is a gateway-operated connector](../adr/0009-in-path-mode-is-a-gateway-operated-connector.md).
  New with this handoff. Whether we serve customers who cannot install a connector, and how
  to do it without becoming two products.
- [0011 — the billing unit is the managed workload](../adr/0011-billing-unit-is-the-managed-workload.md).
  New with this handoff. Resolves the unit-definition question in the pricing draft before it
  can become a contract dispute.

The other three new ones — [0010](../adr/0010-provider-credential-custody-stays-with-the-customer.md)
on credential custody, and the accepted 0004/0005/0007 on incidents and strain — matter but
can wait for step 9.

**Challenge this.** ADRs 0008 through 0011 are all `proposed`. That is the point of this
handoff: they are the decisions being brought to the team, not decisions being announced.

## Step 6 — Is any of this true

Read the [reference index](../references/index.md), then dip into whichever entry backs a
claim you doubted:

- Nobody sells provider risk → [competitive landscape](../references/2026-08-15-ai-gateway-competitive-landscape.md)
- A gateway can be absent by default and inserted only during an incident →
  [interception mechanisms](../references/2026-08-15-incident-interception-mechanisms.md)
- Cross-customer signals can be shared without leaking traffic →
  [anonymization prior art](../references/2026-08-15-strain-signal-anonymization.md)
- No provider publishes a latency floor, and the same model on two hosts measured an 86% p50
  spread → [capability floors](../references/2026-08-15-provider-capability-floors.md)

Each entry separates what a source actually says from what this repository inferred from it.
When you disagree with a spec claim, check which side of that line it came from — that tells
you whether you are disputing a fact or a judgement.

## Step 7 — What needs deciding

Read [Decisions still open](index.md#decisions-still-open) and
[Known defects](index.md#known-defects-stated-plainly) in the table of contents, then the
four open issues:

- [#18](https://github.com/hoomji/henry-ai-router/issues/18) — the productionization
  roadmap, Phases 0–4. Phase 0 is one design partner on the existing code and costs almost
  nothing; it is the cheapest possible test of whether Phases 1–4 are worth doing.
- [#20](https://github.com/hoomji/henry-ai-router/issues/20) — comparison against the
  Uniblock stack, and whether to add an in-path mode.
- [#21](https://github.com/hoomji/henry-ai-router/issues/21) — soft budget versus hard
  budget, and which one the market needs.
- [#22](https://github.com/hoomji/henry-ai-router/issues/22) — pricing, where every number
  is currently a guess calibrated against competitors with a cost structure this product
  does not share.

If you read nothing else after this step, read #18's Phase 0. It is the decision with the
best ratio of information gained to money spent.

## Step 8 — How this relates to Gateway-LLM

Read [`gateway-llm-comparison.md`](gateway-llm-comparison.md).

**Do not skip this one, and do not read it last if you are deciding whether to fund this
repository.** It is the step most likely to change your answer.

Two efforts inside the same company are building something with "gateway" in the name.
`Gateway-LLM` is in the request path by construction, holds provider credentials, bills per
request, and — since the plan the wiki recorded — has acquired fallback, health-aware
provider ordering, upstream capacity management and per-workspace spend limits. That is most
of provider risk management, arrived at from the platform's own side rather than the
customer's.

The document names the four real overlaps, the five things that are still only here, and the
strategic question that follows: stay standalone, become the target-state routing layer
inside `Gateway-LLM`, or run one policy core across two hosts. It recommends the second and
says what would make it wrong.

It also opens by correcting an earlier version of itself, which compared against a spec
rather than against the code and reached a more comfortable conclusion. If you read that
version, read the correction first.

## Step 9 — Only if you are reviewing the build

- [`AGENTS.md`](../../AGENTS.md) — every command with its prerequisites, and the working
  agreement. Long, and the *Common commands* section is the part to read.
- [Gateway design](../design-docs/gateway-design.md) — module layout, the adapter contract,
  the routing seam, and the dependency rule with its two declared concessions.
- [Technical blueprint](../design-docs/technical-blueprint.md) — the same system one level up:
  both runtimes, the five control loops with their separate authorities and time bounds, and
  the seven invariants that span components. Read its section 4 before you change anything,
  because invariant 4 is the one that broke silently once.
- The [connector ExecPlan](../exec-plans/completed/2026-08-15-connector-and-reservation-aware-routing.md),
  specifically *Surprises & Discoveries*. Short, and the best evidence in the repository that
  the harness catches real defects.
- Run it:

```bash
python scripts/setup.py && npm --prefix gateway install && npm --prefix connector install
```

```bash
npm --prefix gateway run e2e
```

Substitute `py` for `python` if that is what your machine has. The e2e run starts the stub
providers, the gateway and a sample application itself and drives seven checks; it needs no
provider credential and no cloud account.

## What to do with your notes

Where you disagree, the repository has a place for it, and using the right one is how the
disagreement survives the meeting:

| Your note is | It belongs in |
|---|---|
| "this behavior is wrong / missing" | A comment on the product spec, or a new open-decision row |
| "this trade-off should have gone the other way" | A comment on the ADR — or a superseding ADR |
| "this claim is not proven" | An issue; the spec's *Delivery evidence* is where the claim lives |
| "this is broken" | An issue |
| "the sequence is wrong" | A comment on [#18](https://github.com/hoomji/henry-ai-router/issues/18) |

The four `proposed` ADRs — 0008 through 0011 — are the ones waiting on this review. Each
needs to move to `accepted` or be superseded with a revised trade-off. That is the concrete
ask.
