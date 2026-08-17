# Handoff: table of contents

The full document set in this repository, in one place, for a team member reviewing the
product proposal. Everything below is a repository-local link, so it works from a clone or
from GitHub.

- **New here?** Read [`reading-guide.md`](reading-guide.md) — it walks this set in order and
  says what to challenge at each stop. Budget 45 minutes for the core path.
- **Deciding whether to build it?** Go straight to the [Decisions still open](#decisions-still-open)
  table and [`gateway-llm-comparison.md`](gateway-llm-comparison.md).
- **One-line status:** two of five product behaviors are built and proven by commands;
  nothing is deployed; every check but one opt-in command runs against simulated providers.

## The proposal in four documents

Read these four and you have the proposal. Everything else in this file is depth behind them.

| # | Document | What it answers | Length |
|---|---|---|---|
| 1 | [`README.md`](../../README.md) | What is this, what is proven, what is not | 5 min |
| 2 | [`docs/product-specs/provider-risk-management-gateway.md`](../product-specs/provider-risk-management-gateway.md) | What the product must do for a user, and how you would know it did | 30 min |
| 3 | [`ARCHITECTURE.md`](../../ARCHITECTURE.md) | How it is put together and what must not be broken | 10 min |
| 4 | [`gateway-llm-comparison.md`](gateway-llm-comparison.md) | How this relates to `Gateway-LLM`, what overlaps, and what is still only here | 15 min |

Two synthesis documents sit across that set rather than inside it. Neither is authoritative
for any fact — both link to the document that owns it — so read them for the argument and the
shape, and follow the links when a number matters.

| Document | What it answers | Length |
|---|---|---|
| [`white-paper.md`](white-paper.md) | Why provider risk is a product, why the out-of-path bet is the mechanism, what that bet forecloses, and what the evidence does not establish | 20 min |
| [`../design-docs/technical-blueprint.md`](../design-docs/technical-blueprint.md) | The target architecture across both runtimes and all five behaviors: five control loops, seven system invariants, where the deferred behaviors attach | 25 min |

## Product intent

| Document | Scope | State |
|---|---|---|
| [Provider risk management gateway](../product-specs/provider-risk-management-gateway.md) | The whole product: five behaviors, the pricing model, acceptance criteria, delivery evidence | `Accepted`, partially delivered |
| [Pricing strategy](../product-specs/pricing-strategy.md) | Rate structure and its reasoning | `Draft` — every number is a hypothesis |
| [Product spec index](../product-specs/index.md) | The store's own contract and state vocabulary | — |

The product spec is the long one and the important one. Its
[Delivery evidence](../product-specs/provider-risk-management-gateway.md#delivery-evidence)
section is the honest part: it names what is proven *and* what that proof does not establish.

## Architecture and design

| Document | Scope |
|---|---|
| [`ARCHITECTURE.md`](../../ARCHITECTURE.md) | System boundary, component map, dependency rules, the two declared concessions to them |
| [Gateway design](../design-docs/gateway-design.md) | Module layout, adapter contract, routing seam, config surface — `Verified` 2026-08-15 |
| [Technical blueprint](../design-docs/technical-blueprint.md) | The whole system, all five behaviors: control loops, system invariants, extension points — `Proposed`, target architecture |
| [Core beliefs](../design-docs/core-beliefs.md) | The operating principles an agent assumes when no specific rule exists |
| [`CONTEXT.md`](../../CONTEXT.md) | Glossary. *Target*, *workload*, *ranked list*, *cell*, *spend under management* — read this if a term in the spec reads oddly |
| [Design docs index](../design-docs/index.md) | Verification status of each design document |

## Decisions

Each ADR states a trade-off that is expensive to reverse. The three at the bottom are new
with this handoff and are the ones that need a decision from the team.

| ADR | Decision | Status |
|---|---|---|
| [0001](../adr/0001-declaration-time-vs-observed-infeasibility.md) | Declaration-time and observed infeasibility are two states, not one | accepted |
| [0002](../adr/0002-durable-target-store-with-cross-process-concurrency.md) | The target document lives in a durable store built for concurrent writers | accepted |
| [0003](../adr/0003-provenance-tiered-capability-catalogue.md) | Capability floors carry provenance and an age; the check abstains on a stale floor | accepted |
| [0004](../adr/0004-incidents-included-not-surcharged.md) | Incidents are included in the subscription, never surcharged | accepted |
| [0005](../adr/0005-strain-evidence-detection-internal.md) | Strain detection reads the internal aggregate; disclosure stays banded | accepted |
| [0006](../adr/0006-routing-authority-stays-gateway-side.md) | Routing policy stays gateway-side; the connector obeys a ranked list | accepted |
| [0007](../adr/0007-strain-contribution-is-a-condition-of-service.md) | Contributing strain evidence is a condition of service | accepted |
| [0008](../adr/0008-budget-enforcement-is-async-connector-side-by-default.md) | Budget enforcement is async and connector-side by default | **proposed** |
| [0009](../adr/0009-in-path-mode-is-a-gateway-operated-connector.md) | In-path mode is a gateway-operated connector, not a second product | **proposed** |
| [0010](../adr/0010-provider-credential-custody-stays-with-the-customer.md) | The gateway takes no custody of provider credentials by default | **proposed** |
| [0011](../adr/0011-billing-unit-is-the-managed-workload.md) | The billing unit is the managed workload, not the connector process | **proposed** |

## What was built, and what it taught

| Document | Scope |
|---|---|
| [Exec plan index](../exec-plans/index.md) | Lifecycle state of every plan |
| [Tracer plan](../exec-plans/completed/2026-08-14-provider-risk-gateway-tracer.md) | M1 fail-open pass-through, M2 target-state routing |
| [Connector and reservation plan](../exec-plans/completed/2026-08-15-connector-and-reservation-aware-routing.md) | The connector, the gateway as control plane, reservation-aware routing. Its *Surprises & Discoveries* is the best short read in the repository |
| [Tech debt tracker](../exec-plans/tech-debt-tracker.md) | Accepted shortcuts — currently empty |
| [`PLAN.md`](../../PLAN.md) | How an ExecPlan is written here |

## External research

Four sourced references, each with provenance and a review date, behind claims in the spec.

| Reference | Behind which claim |
|---|---|
| [AI gateway competitive landscape](../references/2026-08-15-ai-gateway-competitive-landscape.md) | "No existing router sells provider risk"; pricing comparisons |
| [Incident interception mechanisms](../references/2026-08-15-incident-interception-mechanisms.md) | How a gateway can be bypassed by default and inserted only during an incident |
| [Strain-signal anonymization prior art](../references/2026-08-15-strain-signal-anonymization.md) | Behavior 3's aggregation contract |
| [Provider capability floors](../references/2026-08-15-provider-capability-floors.md) | That no provider publishes a latency floor; the 86% same-model host spread |
| [Reference index](../references/index.md) | Provenance and review dates |

## Runtimes and how to run them

| What | Where |
|---|---|
| Gateway (control plane) | [`gateway/`](../../gateway/) |
| Connector (installs in the customer's app) | [`connector/`](../../connector/) |
| Every command, with its prerequisites | [`AGENTS.md`](../../AGENTS.md#common-commands) |
| Onboarding UI prototype — throwaway, three variants | [`docs/prototypes/onboarding-ui/`](../prototypes/onboarding-ui/README.md) |

The two commands worth running yourself:

```bash
npm --prefix gateway run e2e
```

```bash
npm --prefix gateway run load
```

The first drives seven end-to-end checks including "no chat-completion request reaches the
gateway at all." The second fails if setting a target does not move the traffic split.

## The repository as a harness experiment

This repository is also a test of whether a codebase can be built to be worked on by coding
agents. Skip this section if you are only evaluating the product.

| Document | Scope |
|---|---|
| [`AGENTS.md`](../../AGENTS.md) | The agent entrypoint: repository map, commands, working agreement |
| [Harness manifest](../harness/manifest.yaml) | Declared capability state, each claim naming its command |
| [Quality report](../harness/quality-report.md) | Nine capability planes with levels and evidence |
| [Learning ledger](../harness/learning-ledger.md) | Repeated friction turned into a durable fix |
| [Tracer workflow](../harness/tracer-workflow.md) | The representative change and its evidence contract |
| [Docs audit routine](../harness/docs-audit.md) | The passes a script cannot make |
| [Generated docs index](../generated/index.md) | Empty by design |

## Decisions still open

The proposal's real agenda. Each row is a question the repository cannot answer from the
code, with where the argument already is.

| Question | Where it lives | Why it blocks |
|---|---|---|
| Do we pursue in-path proxy mode alongside the out-of-path connector? | [#20](https://github.com/hoomji/henry-ai-router/issues/20), [ADR 0009](../adr/0009-in-path-mode-is-a-gateway-operated-connector.md) | Decides whether hard budget, compliance-constrained customers, and no-call-site-control customers are addressable at all |
| Is soft-budget-by-default viable, or does the market need hard budget? | [#21](https://github.com/hoomji/henry-ai-router/issues/21), [ADR 0008](../adr/0008-budget-enforcement-is-async-connector-side-by-default.md) | If most of the market needs hard budget, the central architectural bet is wrong |
| Which rate structure and which rates? | [#22](https://github.com/hoomji/henry-ai-router/issues/22), [pricing strategy](../product-specs/pricing-strategy.md), [ADR 0011](../adr/0011-billing-unit-is-the-managed-workload.md) | No number in the draft came from a customer or from measured infra cost |
| Do we take custody of provider credentials to make onboarding easier? | [#18](https://github.com/hoomji/henry-ai-router/issues/18) Phase 3, [ADR 0010](../adr/0010-provider-credential-custody-stays-with-the-customer.md) | Trades real liability for onboarding friction |
| Does this ship standalone, fold into `Gateway-LLM` as its routing layer, or run as one policy core with two hosts? | [#20](https://github.com/hoomji/henry-ai-router/issues/20), [comparison](gateway-llm-comparison.md) | `Gateway-LLM` is acquiring every part of this product except target-state routing |
| What is the productionization sequence? | [#18](https://github.com/hoomji/henry-ai-router/issues/18) | Phases 0–4, multi-quarter; Phase 0 is a design partner and costs almost nothing |
| Infra cost and capacity for the push model | [`ARCHITECTURE.md`](../../ARCHITECTURE.md) flags it as undocumented | Blocks any per-connector rate grounded in our own cost |

## Known defects, stated plainly

- A non-default customer's usage reports corrupt the default customer's status. Demonstrated
  by e2e check 3b today; must be fixed before multi-tenancy, per
  [#18](https://github.com/hoomji/henry-ai-router/issues/18) Phase 2.
- No capability floor has ever been measured against a real provider. The floors the
  feasibility check rejects targets against are plausible numbers.
- CI runs and is green but cannot be made required on this repository's plan, so a red run
  does not block a merge.
