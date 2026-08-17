# henry-ai-router compared with uniblock-llm-gateway and the LLM Gateway V1 spec

- Written: 2026-08-17
- Compares: this repository at `07a52c4` on `master`
- Against: `Uniblock-dev/uniblock-llm-gateway` at `main` (`HANDOFF.md`, `AGENTS.md`, repository
  layout, read 2026-08-17), and the two `Uniblock-dev/uniblock-wiki` documents pinned at
  `4998118f68a94ce666b9d628630397eabce030f9`:
  - `docs/product-spec/2026-08-14-llm-gateway-v1.md` — LLM Gateway V1 product specification
  - `docs/exec-plans/2026-08-14-llm-gateway-v1.md` — its ExecPlan
- Extends: [#20](https://github.com/hoomji/henry-ai-router/issues/20), which compared this
  repository against the blockchain stack (`unified-request`, `auto-route`, `key-manager`,
  `gateway-rs`, `uniblock-dashboard-front-end`). This document is the LLM-side comparison #20
  did not cover, against a specification that did not exist when #20 was written.

## The short version

**These are not competing products, and one sentence in the V1 spec is why: V1 is "a router
with no routing."** Its §3.2 cuts model fallbacks, retries, and "any routing at all" — the
customer names a model and gets it. Everything this repository is about begins after that cut.

V1 builds the **access and money plane**: one key, one bill, several vendors, a dollar figure
per call, prepaid credits, a dashboard, on Cloudflare, for a demo on 2026-09-01.
`henry-ai-router` builds the **risk and routing plane**: a customer states a latency, cost or
success-rate target and the system holds it by moving traffic, with the gateway out of the
request path.

They are sequential, not alternative — and V1's own specification already reserves the seam
where the second one plugs in. But there are four genuine collisions, and one of them is a
pricing contradiction that would be visible to a customer who saw both.

## What each one is, today

| | `henry-ai-router` | `uniblock-llm-gateway` (repo today) | LLM Gateway V1 (spec, 2026-08-14) |
|---|---|---|---|
| Thesis | Provider risk management; hold a stated target | Resell model access at provider price plus markup | One key, one bill, several vendors, visible cost |
| Request path | **Gateway is out of it.** Connector in the customer's app calls providers directly | In path — LiteLLM proxy terminates the request | In path — Cloudflare Worker terminates `/v1/chat/completions` |
| Routing | The product. Target-state ranked lists, no routing rules | LiteLLM's, largely unused | **None, by design** |
| Fallback | Connector fails over on 429/5xx; ranked list ordering | LiteLLM's, available | **Cut**, and argued rather than deferred |
| Streaming | Built and measured — TTFB 1070 ms against a 3084 ms stream | Both paths work (margin confirmed on both) | **Out of V1** |
| Billing | Flat subscription tiered on *spend under management*; no % of spend, no per-request markup | 15% global cost margin, proven working end to end | Token-to-dollar, prepaid credits, Stripe top-ups; no compute units |
| Provider credentials | **Customer's own; never reach the gateway** | Uniblock-held, encrypted in LiteLLM's store | **Uniblock-held**, one shared pool across tenants |
| Platform | TypeScript on Node 24, zero runtime deps, **nothing deployed** | Python LiteLLM fork + Postgres + Prometheus + Grafana, `docker compose up` locally | Cloudflare Workers; LiteLLM fork explicitly abandoned |
| Deadline | None | — | **2026-08-28**, demo 2026-09-01 |
| Staffing | One author | — | Abby, Henry, Taiki, + Tony, Jeremy, Robert |
| Evidence discipline | Every claim names a command; 240 tests, 7-check e2e, load run that fails on a flat split | Measured, not assumed — `HANDOFF.md` is unusually honest about it | 12 acceptance criteria, each observable |

## Where they genuinely collide

### 1. In-path mode — V1 already is one, so we should not build a second

[ADR 0009](../adr/0009-in-path-mode-is-a-gateway-operated-connector.md) proposes serving
customers who cannot install a connector by running "a connector the gateway operates for you."
V1 is that thing: a Cloudflare Worker that terminates an OpenAI-compatible request, holds the
provider credential, and makes the upstream call. Building a second in-path host inside
`henry-ai-router` would put two of them in one company.

**Recommendation.** Do not implement in-path mode here. Implement 0009's *contract* — a
documented way for a gateway-operated host to consume `computeRankedList` and to report usage
through the existing ingestion path — and name V1 as the first host of it. That keeps 0009's
load-bearing constraint intact (one policy implementation, never two) and turns a build into an
integration.

**What that requires of V1 in return:** nothing now, and one thing later. If V1 ever adds
routing, it consumes this control plane rather than growing its own. Which brings up the seam.

### 2. V1's routing-profile namespace is the integration seam, and it is already reserved

V1's §3.3, *deliberately deferred but designed for*, says the future routing shape is not a
fallback list but a profile created in the dashboard and requested through a **custom namespace
in place of a model name**, and it therefore requires V1 to treat the `model` field as a
"namespace-resolved identifier, not a literal upstream id." Its ExecPlan M1 carries that as a
schema design rule.

That is, almost exactly, a *workload* — a customer-named class of traffic carrying routing
preferences. `henry-ai-router` already has the workload concept, the versioned target document
with optimistic concurrency, declaration-time feasibility checking, rolling measurement windows,
the `unmet` state machine, and a ranked-list computation with a binding reason for every
decision.

**Recommendation.** Reserve the seam explicitly on both sides now, while it costs nothing: V1's
namespace resolution is where a target-state workload would resolve, and the profile the
dashboard creates is a target document. Record it in V1's §3.3 and in this repository's
[#20](https://github.com/hoomji/henry-ai-router/issues/20). The alternative is that V1 ships
routing profiles as a small dashboard feature in a later quarter and re-derives, badly, what the
product spec here already specifies at length.

### 3. The pricing models contradict each other, in public

| | `henry-ai-router` | V1 |
|---|---|---|
| Shape | Flat subscription, tiered on spend under management | Token-to-dollar with prepaid credits |
| Markup on inference | **None.** "No percentage of spend, no per-request markup" | Provider price plus a markup; 15% proven in the current repo |
| Reason | We are not in the path and do not carry the tokens; charging for volume we never touch is the proxy-markup story the positioning refuses | We are in the path and pay the provider first |

Both are internally coherent. Each is a reasonable answer for its own architecture. But they are
opposite answers to "what do you charge for?", and a prospective customer who is shown both will
ask which one Uniblock believes. V1's own open decision **D6** records that nothing in any source
names a price, a margin or a markup — so this is genuinely unresolved on that side, not settled
and merely different.

**Recommendation.** Resolve the two together, not independently. The defensible combined story is
that inference access is sold at cost-plus (V1's markup) and *risk management* is sold as a
subscription on top (this repository's model, and
[ADR 0011](../adr/0011-billing-unit-is-the-managed-workload.md)'s workload unit) — two line
items for two different things, rather than two theories of one line item. That needs deciding
before either publishes a rate card, and it belongs to whoever owns V1's D6.

### 4. Credential custody points in opposite directions — and V1's model is a live risk

[ADR 0010](../adr/0010-provider-credential-custody-stays-with-the-customer.md) proposes that
provider credentials never reach the gateway. V1 holds Uniblock's own provider accounts as its
core mechanism — its spec calls this the real work, quoting Taiki's correction that "adapters
doesn't capture the admin keys portion" — and its ExecPlan M3 records the consequence as a known
limitation: **one shared upstream key pool, so one abusive tenant can get a provider account
rate-limited for everyone.**

That is worth stating plainly because of what it is: `henry-ai-router` exists to sell protection
from provider rate-limit and degradation risk, and V1's architecture manufactures exactly that
risk internally, for every V1 customer at once. Its stated mitigation is utilization tracking
plus an alert.

**Recommendation.** Two things, neither of which is "change V1's model" — the shared pool is the
right call for a two-week V1. First, the per-provider rate-limit tracking V1's M3 already commits
to ("track provider rate limits properly this time") is the first real strain signal either
product could have, and it is more valuable than the mitigation it was scoped as. Second, when
V1's shared pool does get one provider throttled, that is the in-house design partner
[#18](https://github.com/hoomji/henry-ai-router/issues/18) Phase 0 asks for — the pain is real,
internal, and does not need a customer to volunteer for it.

## The strongest external challenge to this repository's thesis

V1's §4 argues against fallback substantively rather than on schedule, and the argument lands
against this product too. Paraphrasing the positions on record: a JSON-RPC answer is
provider-independent, so falling back is free — the price of Bitcoin is the same whoever serves
it. A model answer is not. Routing to a different model produces different output and can break
the calling system, and the great majority of real usage names exactly the model it wants.

If that is right, then "hold a latency target by moving traffic between providers" is selling
something a customer will refuse the first time an output changes shape.

This repository has an answer, and the handoff should lead with it rather than wait to be asked:
`allowed_models` is a **required, non-empty list**, and listing several models is the customer's
own assertion that they are interchangeable *for that workload*. The gateway routes only inside
the blast radius the customer drew, never adapts a prompt when moving between two models they
listed, and a customer who does not want a model's output removes it. Behavior 5, prompt
translation, exists for cross-model failover during an interception window — not for ordinary
routing. And the bare-versus-pinned model distinction means the common case is the *same* model
on a different host, where the output concern largely disappears and the measured spread was 86%
in p50 latency on a single day.

That is a real answer. It is not a proven one: no customer has ever declared an
`allowed_models` list.

## What each repository could take from the other, today

**`henry-ai-router` → V1**

- **Streaming is already solved here, and V1's plan flags it twice as a risk.** The connector
  relays streams without buffering and `npm --prefix connector run stream-probe` exists
  specifically because a connector that quietly buffers passes every other check. V1's §3.3 warns
  that V1 "must not assume it can read the whole upstream body to bill"; that assumption is what
  the stream probe tests.
- **The load run as an evidence pattern.** `npm --prefix gateway run load` exits non-zero unless
  the traffic split moves with the target — an artifact that can fail. V1's C4 (cost
  reconciliation, "exact match, not tolerance") and C6 (one usage record and one debit,
  idempotent under redelivery) are exactly the shape of claim that wants a runnable artifact
  rather than a test.
- **Effective-dated prices are the same decision as the rate card here.** The pricing model
  already separates a forward-only *rate card* from the *capability catalogue*, for the reason
  V1's M1 gives independently: a price correction must never restate a settled invoice.

**V1 → `henry-ai-router`**

- **A deadline, a demo, and named staff.** This repository has none of the three, and V1's
  constraint — Kevin's "I don't want too much throwaway work" — is a better forcing function than
  anything in [#18](https://github.com/hoomji/henry-ai-router/issues/18).
- **The billing schema discipline.** Money in integer minor units, prices as effective-dated
  decimal-string rows, never edited in place. This repository has no billing code at all and will
  need exactly that.
- **`HANDOFF.md` as a document type.** "What is proven, not assumed", "traps that cost real
  money", "needs a human", "do not trust". It records that a review's own claim about a
  `/metrics` leak did not exist and says not to spend time on it. That is a form this
  repository's learning ledger does not have.

## One thing the team should know about the other repository

`uniblock-llm-gateway`'s working code and its own new specification disagree. The repository is a
vendored LiteLLM fork with real measured results — a 15% margin working on both streaming and
non-streaming paths with zero code changes, 69 migrated tables, Prometheus and Grafana wired up —
and the V1 spec **abandons that base**: "the LiteLLM fork is off", rebuild on Cloudflare with
Portkey as a read-only code reference, nothing reused from the existing key manager.

That may well be right — the fork cannot deploy to Cloudflare, and understanding one of its
features was costed at over two weeks per developer. But three findings in `HANDOFF.md` are
findings about *building a metered multi-tenant gateway*, not about LiteLLM, and they survive the
platform change:

- A budget-escalation hole where provisioning through one endpoint mints a key with no ceiling.
  V1's C5 (402 before any upstream call) is the criterion that would catch its equivalent.
- A spent key returning 429, which OpenAI-compatible SDKs auto-retry — so a customer out of
  credit becomes a retry storm. V1's failure-behavior section already specifies 402 for
  insufficient credit; this is *why* that line matters.
- A wildcard model entry where 611 models have no price and resolve to zero, so those calls never
  touch a balance and Uniblock pays for them. V1's C9 — a provider that omits usage is flagged,
  never silently estimated into revenue — is the same defect class.

Carrying those three forward as tests rather than as memory is the cheapest thing either effort
can do this week.
