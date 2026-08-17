# Gateway design: modules, adapter contract, routing seam

- State: `Verified`
- Owner: henry.tran@uniblock.dev
- Last verified: 2026-08-15 — against the completed connector and reservation ExecPlan.
  Every module in the layout below now exists, including `controlplane/` and
  `reservations/`; the dependency rule holds with its two declared concessions
  (`targets/store.ts` on `node:sqlite`, `controlplane/api.ts` on `node:http`); the routing
  seam populates a binding reason over several candidates and kept its signature and purity
  through the reservation change; the load run demonstrates the split moving with the
  target; and the end-to-end run demonstrates the gateway staying out of the request path
  while a connector serves it. What remains unverified is not in this document's scope: a
  reproducible, credential-gated check now reaches a real provider
  (`npm --prefix gateway run real-provider-check`, reached OpenRouter on 2026-08-17 — see
  [the learning ledger](../harness/learning-ledger.md)), but it is a smoke test, not a
  measured capability floor. Every capability floor this design doc relies on is still
  unmeasured and simulated.
- Domain language: [`../../CONTEXT.md`](../../CONTEXT.md)
- Review trigger: the first commit under `gateway/`, or any revision to the governing
  spec or ExecPlan below
- Governing spec: [`../product-specs/provider-risk-management-gateway.md`](../product-specs/provider-risk-management-gateway.md)
- Implementation sequence: [`../exec-plans/completed/2026-08-14-provider-risk-gateway-tracer.md`](../exec-plans/completed/2026-08-14-provider-risk-gateway-tracer.md),
  then [`../exec-plans/completed/2026-08-15-connector-and-reservation-aware-routing.md`](../exec-plans/completed/2026-08-15-connector-and-reservation-aware-routing.md)

## Problem context

The product spec requires a gateway whose defining promise is provider risk management:
fail-open forwarding, target-state routing, and later strain-triggered interception,
cross-customer strain signals, and prompt translation. The ExecPlan's Decision Log fixes
the platform: TypeScript on Node.js 24+, inside this repository, with the request data
path kept thin enough to reimplement in Rust or Go later without rewriting routing policy
or provider adapters. This document scopes how the code is shaped to honor those
decisions. It does not restate required behavior (the spec owns that) or sequence the
work (the ExecPlan owns that).

## Goals and non-goals

Goals: a module layout whose seams survive all five spec behaviors; an adapter contract a
future non-TypeScript data plane could honor; a routing seam that is pure policy over a
state snapshot; a config surface that grows without breaking the two-variable tracer.

Non-goals: designing behaviors 2–5 in detail (their product decisions are open). Deployment
topology is a partial exception, noted below.

Multi-tenancy and authn were previously one non-goal here, and
[#8](https://github.com/hoomji/henry-ai-router/issues/8) showed they are two things with
different triggers. **Authn and a real customer key are not deferred past the tracer.** The
*connector* — the customer-installed component that calls providers directly and obeys the
ranked list this gateway pushes — must identify itself to be pushed a list and to report
token counts, and the spec requires metering to run for every connected customer from their
first day, which a single hardcoded customer key cannot express. That work lands in the
connector's own ExecPlan, immediately after the tracer. What stays deferred is **cohort
multi-tenancy**: cross-customer cohort membership, which behavior 3 needs and which is a
data-model change rather than an identity one.

Persistence is no longer a non-goal at all. Behavior 1, as specified after
[#6](https://github.com/hoomji/henry-ai-router/issues/6), requires a versioned target
document with optimistic concurrency and a per-customer notification secret.
[#13](https://github.com/hoomji/henry-ai-router/issues/13) resolved that M2 ships the real
store rather than an in-memory stand-in, and that the store is designed for concurrent
writers from the first milestone (ADR
[`0002`](../adr/0002-durable-target-store-with-cross-process-concurrency.md)). See
*Durability and the target store* below.

Deployment topology consequently could not be kept fully out of scope: designing for
concurrent writers presumes more than one gateway process.

**Authn is no longer a non-goal, and the sentence that used to stand here is now false.** It
said the store carried a customer key column with a single hardcoded value and no API
surface. The connector ExecPlan removed all three parts of that: a `connectors` table holds
minted bearer tokens against the customer they belong to, `POST /v1/admin/connectors` mints
one behind `GATEWAY_ADMIN_TOKEN`, every connector endpoint resolves its customer from the
token, and the store exposes a `forCustomer()` view through which queries are scoped —
replacing the hardcoded `CUSTOMER_ID` outright. What stays a non-goal is exactly what the
paragraph above names: cohort multi-tenancy, the cross-customer data-model change behavior 3
needs. Per-customer *measurement* is deferred with it, and that deferral is load-bearing
rather than cosmetic — the measurement windows are keyed by (workload, provider) and carry
no customer dimension, so only the service's own customer's usage reports are folded into
them. Folding several customers in would silently average one customer's providers into
another customer's target.

## Module layout (proposed)

    gateway/
      package.json            name "gateway", "type": "module", engines node >= 24
      tsconfig.json
      src/
        server.ts             HTTP surface + fail-open wrapper (the data path)
        types.ts              GatewayRequest, GatewayResponse, Provider, ProviderState,
                              Target, Workload, RoutingDecision
        config.ts             reads and validates the environment/config surface
        routing/
          chooseProvider.ts   pure policy: (request, state) -> RoutingDecision
          stats.ts            rolling windows that produce ProviderState snapshots
        targets/
          document.ts         the target document: parse, validate, version
          store.ts            the target store: durable read/CAS-write, boot load, polling
          feasibility.ts      declaration-time check against the capability catalogue
          unmet.ts            the two-window state machine over merged window summaries
          service.ts          assembles the apparatus: the in-memory document copy, the
                              polling refresh, the window lifecycle, the unmet advance
        reservations/
          document.ts         the reservation document: parse, validate, version
          unaddressed.ts      pre-paid capacity a customer's traffic is failing to address
        controlplane/
          rankedList.ts       pure: derives a total order by calling chooseProvider repeatedly
          directives.ts       the push scheduler, debounced per workload
          usageOutcome.ts     pure: maps a reported call to a RequestOutcome for the windows
          api.ts              the connector-facing surface: SSE stream, ack, lists, usage,
                              admin mint, GET/PUT /v1/reservations
        management/
          api.ts              GET/PUT /v1/targets, GET /v1/workloads/{name}/status
          notify.ts           signed, at-least-once unmet-transition notification
        providers/
          adapter.ts          the ProviderAdapter interface
          passthrough.ts      M1's sole adapter
          capabilities.ts     capability floors keyed (model, host, region, tier), with
                              provenance and TTL (feasibility input)
        dev/
          stubUpstream.ts     canned-completion upstream for credential-free testing
          simProvider.ts      parameterized simulated providers (latency, cost, failure)
          load.ts             M2 load script: prints traffic split, measured p95, status
          e2e.ts              the connector plan's evidence artifact: starts stubs, gateway
                              and sample apps, drives seven checks, exits non-zero on failure
          e2eStub.ts          the stub provider the e2e run drives
          loggedGateway.ts    the gateway with an HTTP access log, so "no chat-completion
                              request reaches the gateway" is observable by eye

Dependency direction is one-way: `server.ts`, `management/` and `controlplane/` import
routing, targets, reservations and providers; nothing under `routing/`, `targets/`,
`reservations/`, or `providers/` imports `server.ts`, `management/`, `controlplane/`,
`node:http`, or any framework type. That rule is what the Decision Log's "portable data
path" claim rests on, and it is the first thing a reviewer should check in every gateway PR.

There are now **two** deliberate concessions, and both are declared here so a reviewer can
tell a concession from drift. `targets/store.ts` performs I/O against `node:sqlite`. And
`controlplane/api.ts` imports `node:http`, exactly as `management/api.ts` does, because it
is an HTTP surface — it is the connector-facing edge, not policy. Each is confined to its
one module for the same reason: so the rest of `targets/` and the whole of `controlplane/`'s
logic stays pure, and so a Rust or Go data plane replaces one file rather than a package.
The confinement is checkable rather than asserted — `store.ts` is the only file under `src/`
naming `node:sqlite`, and `node:http` appears only in `server.ts`, `management/api.ts`,
`controlplane/api.ts` and the `dev/` files.

That split is why `controlplane/` has four modules rather than one. `rankedList.ts` and
`usageOutcome.ts` are pure functions with no HTTP in them: the first derives a total order
over providers, the second maps a connector-reported call to a `RequestOutcome`. Both are
the kind of logic that must be unit-testable without a socket, and both were placed outside
`api.ts` for that reason. `directives.ts` holds the push scheduler and its per-workload
debounce. Only `api.ts` touches the wire.

`targets/service.ts` was added during M2 and is the one module this layout did not
originally name. It exists because the four modules beside it are pieces rather than an
apparatus: something has to own the store handle, the in-memory document copy, the polling
refresh, the window lifecycle, and the `unmet` advance, and leaving that assembly inside
`server.ts` would have put control-plane state in the data path. Its placement is decided
by the dependency rule rather than by taste. Both `server.ts` and `management/api.ts` need
it — the data path to route on the current target, the management surface to serve and
replace it — so it must sit where both may import it; and since nothing under `targets/`
may import `management/`, `targets/` is the only directory that satisfies both. The same
rule explains one shape inside it: it delivers `unmet` transitions through an injected
callback rather than importing `management/notify.ts`, because the convenience import would
have been the first crack in the rule it was placed to respect.

`management/` is deliberately a sibling of `server.ts` rather than part of it: the
management surfaces are control-plane, serve no customer model traffic, and must be able
to fail without touching the data path. A management outage must never be able to break
forwarding — the fail-open boundary applies to our own control plane too. `controlplane/` is
a sibling on the same argument: it serves connectors, not model traffic.

## The connector as a sibling runtime

This document scopes `gateway/`. It is no longer the only runtime in the repository, and the
other one changes what this one is. `connector/` is a second top-level TypeScript package
under the same constraints — Node 24 or newer, `tsc`, no runtime dependency outside the Node
standard library — holding the component that installs into a customer's own application at
their call site. **In normal operation the connector, not the gateway, is what calls a
provider.** The gateway's data path is kept for behavior 2's interception window, not because
it carries traffic today.

Two consequences land inside this document's scope, and neither is obvious from the code.

First, the ranked list is the entire routing product in normal operation, and it comes from
this document's routing seam by repeated call rather than from a comparator — see *Routing
seam* below. The connector holds no policy at all beyond "on error, try the next provider in
the list".

Second, and more easily broken: **connector-reported usage is the only input the measurement
windows have.** With the gateway out of the request path, `routing/stats.ts` sees nothing
from `server.ts` in production, so the windows are fed at ingestion in `controlplane/api.ts`
by way of the pure `usageOutcome.ts`. This was got wrong once — reports were persisted for
billing and never folded into the windows, which left every provider `insufficient_data`
forever and made `unmet` unreachable — and it was invisible to unit tests because every test
of `unmet` reached the windows through the in-path path. Three rules protect it now. A
shared `classifyStatus` in `routing/stats.ts` serves both paths so the two classifications
cannot drift; it treats the connector's `statusCode: 0` transport-failure encoding as
provider risk rather than success, the trap being that `0 < 400`. A record naming a provider
with no catalogue entry is dropped as unpriceable rather than priced at zero, because a zero
rate is indistinguishable from free capacity. And only the service's own customer's records
are folded in, because the windows carry no customer dimension.

## Provider adapter contract (proposed)

An adapter is a pure translation pair, no I/O, no framework types:

    interface ProviderAdapter {
      readonly id: string
      toUpstream(req: GatewayRequest): UpstreamRequest    // method, path, headers, body
      fromUpstream(res: UpstreamResponse): GatewayResponse
      costOf(req: GatewayRequest, res: GatewayResponse): number  // per-request cost estimate
    }

`UpstreamRequest`/`UpstreamResponse` are plain-data shapes (strings, headers record, body
bytes or JSON), so the same contract can be re-expressed as a Rust trait or Go interface.
The actual `fetch` happens in `server.ts`, not in the adapter — adapters describe the
call; the data path performs it. `costOf` exists from M1 (returning a constant for the
passthrough adapter) because target-state routing (M2) and reservation-aware routing (spec
behavior 4) both consume per-request cost, and retrofitting it later would touch every
adapter.

Streaming: the tracer buffers responses. When streaming lands *here*, the adapter contract
gains a chunk-transform function rather than a stream object, keeping adapters pure; this is
noted now so nobody designs adapters around whole-body assumptions.

That deferral is about this contract only, and the distinction matters because "streaming is
deferred" is now half false. Per [#8](https://github.com/hoomji/henry-ai-router/issues/8) the
*connector* is in the streaming path from its first day — real chat traffic streams and the
connector is what calls the provider — but it only relays bytes and counts tokens at the end,
never transforming a chunk. The adapter's chunk transform is needed only when the gateway is
mid-stream, which happens during an *interception window* (behavior 2) and not before. So:
streaming pass-through ships with the connector; chunk transform stays deferred here.

## Routing seam (proposed)

    chooseProvider(request: GatewayRequest, state: ProviderState): RoutingDecision

- Pure and synchronous: no clock reads, no network, no global state. Everything it may
  consider — rolling p95 per provider, observed cost and success rate, the workload's
  `Target`, interception-window flags later — arrives inside the `ProviderState` snapshot.
- Snapshots are produced by `routing/stats.ts`, which the data path feeds with
  (provider, latency, cost, outcome) observations after each request completes. Stats
  collection is the only stateful part of routing, and it is write-only from the data
  path's perspective.
- **The return type is a decision, not a provider.** Per
  [#6](https://github.com/hoomji/henry-ai-router/issues/6), both infeasibility reports are
  specified as diagnoses that name why each candidate was rejected, so the binding reason
  must be produced by the decision itself — a reason reconstructed from logs afterwards is
  not trustworthy. Proposed shape:

      type RoutingDecision =
        | { chosen: Provider; bound: Dimension | null; rejected: RejectionReason[] }
        | { chosen: null; failed: { dimension: Dimension; reason: 'hard-dimension' } }

  The second case exists because a `hard` dimension fails the request rather than
  breaching it; that is a routing outcome, not an error, and must not be conflated with a
  defect.
- Infeasibility is a return value, never an exception — and it is two distinct states, not
  one (ADR [`0001`](../adr/0001-declaration-time-vs-observed-infeasibility.md)).
  `infeasible_by_declaration` never reaches this function at all: it is rejected at target
  document write time by `targets/feasibility.ts`, so `chooseProvider` may assume its
  target was satisfiable by *someone* when written. `unmet` is derived by
  `targets/unmet.ts` from the sequence of decisions and observations over windows, not
  decided inside a single call — one request cannot know whether two windows have been
  missed. Keeping both states outside the seam is what lets it stay pure.
  Exceptions from `chooseProvider` remain reserved for genuine defects, which is what
  makes the fail-open wrapper's semantics clean.
- **The same seam produces the pushed ranked list.** In normal operation the gateway is out
  of the request path and routing reaches the customer as an ordered list of providers pushed
  to the *connector* (ADR
  [`0006`](../adr/0006-routing-authority-stays-gateway-side.md)). The control plane builds
  that list by calling this function against the current snapshot and sorting by its
  decision, rather than by a second ordering routine. This is the payoff of the purity
  constraint: one implementation serves both the pushed list and the per-request choice the
  gateway makes while it is in the path during an *interception window*. It also fixes where
  policy lives — the connector evaluates no target and holds no policy, carrying only the
  rule "on error, try the next provider in the list". The list is derived by calling this
  function repeatedly rather than by a comparator, precisely so a second implementation of
  the routing decision cannot come into existence.
- **Reservation preference lives inside the seam, and the clock does not.** Behavior 4 adds a
  branch preferring a provider that addresses a live reservation for the requested model, and
  costing it at the reservation's effective rate rather than the catalogue's public rate. It
  is a preference, not an override: it never beats a `hard` dimension and never leaves
  `allowed_models`, and it is inert when a customer has declared no reservations. Whether a
  reservation's term is *live* is a clock question, so it is resolved by the caller into
  `state.liveReservations` rather than read inside the function. That is what let the change
  land without altering the signature or the purity this whole section depends on.

## Fail-open forwarding path (proposed)

`server.ts` wraps the seam:

1. Parse the inbound request into a `GatewayRequest`.
2. Call `chooseProvider` inside a try/catch.
3. On success, use the chosen provider's adapter; on throw (or on the test flag
   `FORCE_ROUTER_ERROR=1`), forward to the default upstream (`UPSTREAM_BASE_URL`) with the
   passthrough adapter and set `x-gateway-failopen: true`.
4. Record the observation into `stats.ts` either way, so fail-open traffic still teaches
   the router.

The fail-open default is deliberately the *configured* upstream, not a gateway-chosen
alternative: when our logic is broken we must degrade to exactly what the customer would
have done without us (spec's fail-open boundary). Note the spec's stronger criterion —
"with the gateway *down*, traffic still reaches the provider" — is a deployment concern
(DNS/SDK-level bypass), out of this document's scope and flagged as such.

## Target-state routing loop (proposed)

Behavior 1 is specified in full in the product spec's *Target-state routing in detail*
section; this document only shapes the code that implements it. The vocabulary below
follows that section — it is no longer the two-field `{ p95_ms, cost_per_1k }` sketch that
predated [#6](https://github.com/hoomji/henry-ai-router/issues/6).

A `Target` belongs to a named `Workload`, not to a customer: `allowed_models` (required,
non-empty), zero or more of the three dimensions `p95_ms`, `cost_per_1k_tokens_usd`,
`success_rate`, one `objective`, a `priority` order, and at most one `hard` dimension.
Requests select their workload by the `x-gateway-workload` header, resolved in
`server.ts` before the seam is called, so `chooseProvider` receives an already-resolved
target and never parses headers.

Each snapshot carries, per provider **and per workload**, a rolling window spanning
trailing 5 minutes or 200 requests, whichever is longer. The per-workload split matters:
a shared window would let batch traffic's latency mask an interactive workload's
regression. Below the sample floor a dimension's value is `insufficient_data` — a distinct
value in the snapshot, not a null and not a zero, so the seam cannot accidentally treat an
unmeasured dimension as a satisfied one.

**Two lookbacks, not one.** `targets/service.ts` reads the store's window summaries twice
per tick with different horizons, because the two consumers are asking different questions.
What routing and the status resource report is a *trailing* measurement — the last three
closed windows folded together, which is what a window "spanning trailing 5 minutes or 200
requests" actually means in a store that keeps one row per closed window. A single closed
window would make the evidence evaporate moments after it was gathered, dropping every
provider back to `insufficient_data` and re-triggering exploration over traffic we had just
measured. The `unmet` machine, by contrast, judges *the window that just closed* and only
that one: folding older windows back in would keep judging a recovered workload on the
windows it had already recovered from, which would break the deliberate symmetry of the
two-window entry and the two-window exit. Summaries are pruned at three windows, so the
trailing horizon and the retention horizon are the same number by construction.

**Exploration.** A provider that is never chosen can never be measured, so the seam
deliberately prefers a provider with no measurement over a measured one. This is a
correctness requirement rather than a heuristic — without it the first provider to be
measured keeps the traffic and the alternatives stay permanently `insufficient_data` — but
it has a consequence for anyone reading a short run: until every candidate has been
measured, the observed traffic split is the exploration transient and not the routing
policy. That is why the load script warms up before it measures, and why a split read
before warm-up completes says nothing about whether targets work.

`chooseProvider` projects each dimension per provider for the next request, restricted to
`allowed_models`, and picks the provider minimizing the objective among those holding
every ceiling. When none holds every ceiling, the lowest-priority ceiling yields and the
yielded dimension is reported as `bound`; a `hard` dimension never yields and the request
fails instead.

Anti-oscillation: the choice is sticky within a small hysteresis band (a provider must
beat the incumbent by a margin, proposed 10%, to take over). This is separate from — and
must not be confused with — the two-window hysteresis on the `unmet` state: one damps
provider switching per request, the other damps customer-visible state transitions. The
ExecPlan's ≤20% oscillation criterion measures the first.

## Target document and management surfaces (proposed)

The target document is the single source of truth (spec, #6). `targets/document.ts` owns
parse, validation, and versioning; every read returns a version and every write must
supply the version it replaces, with a mismatch rejected as `409`. Validation rejects
unknown dimension names rather than ignoring them — the vocabulary is closed on purpose,
and silently dropping an unrecognized dimension would let a customer believe they had
stated a target they had not.

`targets/feasibility.ts` runs the declaration-time check on every write, against the
capability catalogue in `providers/capabilities.ts`, and returns `422` with the dimension,
the requested value, the best achievable value, the provider achieving it, and — per
[#12](https://github.com/hoomji/henry-ai-router/issues/12) — the provenance and age of the
floor it decided against. A bare number is not disputable, and disputing it is the
customer's only recourse against a floor that is wrong. The check may also decline to
answer; see *The capability catalogue* below.

`targets/unmet.ts` holds the two-window state machine, entering `unmet` after two
consecutive missed windows and leaving after two consecutive held windows, symmetric by
design so notifications cannot flap. It evaluates over *merged* window summaries and
persists its state, both of which are specified in the next section.

`management/api.ts` serves the document and the per-workload status resource, which is the
**authoritative** record of current state. `management/notify.ts` posts unmet transitions
with an HMAC signature over the body and bounded retry (~15 minutes), then drops. Dropping
is correct rather than lossy precisely because the status resource is authoritative — a
customer's notification endpoint is often down for the same reason their target is unmet,
and a notification queue that grows without bound during an incident is a worse failure
than a missed notification.

## The capability catalogue (proposed)

Resolved by [#12](https://github.com/hoomji/henry-ai-router/issues/12) on the evidence of
[#11](https://github.com/hoomji/henry-ai-router/issues/11); the decision is recorded in ADR
[`0003`](../adr/0003-provenance-tiered-capability-catalogue.md), which also amends ADR
[`0001`](../adr/0001-declaration-time-vs-observed-infeasibility.md). This section replaces
the note that previously called the catalogue this document's weakest assumption. The
weakness was real but misdiagnosed: the problem was never upkeep discipline, it was that
the catalogue's key was wrong and its inputs largely do not exist.

**The key.** A **capability floor** is keyed `(model, host, region, service_tier)`, not per
model. Claude Sonnet 4.5 on 2026-08-15 measured p50 744 ms on `vertexAnthropic`, 795 ms on
`anthropic`, and 1383 ms on `bedrock` — 86% spread on p50, 165% on p95, same model, same
day. A per-model floor must pick the optimistic value or the pessimistic one and is wrong
in one direction either way. Bedrock's `service_tier` alone gives one model four latency
profiles from a per-request flag.

An `allowed_models` entry stays a bare model string, meaning *any host we can reach for
this model*, and may optionally be qualified (`claude-sonnet-4.5@bedrock`) when the
customer wants to pin one. Bare entries collapse optimistically across hosts. This keeps
`allowed_models` a blast radius rather than a routing table, and gives the `422` something
worth saying: "achievable at 780 ms on `vertexAnthropic`, but not on the `bedrock` host you
pinned" is a diagnosis; a bare number is not.

**Provenance and refresh.** Every floor carries the tier it came from and its age. Tiers
resolve in precedence order, and an expired floor demotes to the next one down rather than
being used stale:

| Tier | Source | TTL |
|---|---|---|
| `measured` | Our own traffic, via `routing/stats.ts` | Rolls continuously |
| `third_party` | Vercel AI Gateway's unauthenticated endpoints API (live p50/p95, uptime per (model, host)) | Polled daily, expires at 7 days |
| `published` | Provider rate cards — cost only; no provider publishes a latency floor | 30 days |
| `declared` | Hand-entered, with a written justification | 90 days |

When every tier for a key has expired, feasibility **abstains** and the write is accepted.
The owner is henry.tran@uniblock.dev, but the enforcement is the TTL, not the owner: the
accountable signal is the *abstention rate*, which is visible, rather than a review cadence,
which is remembered. `measured` stays in process. The other three ship as a generated
artifact under `docs/generated/`, refreshed by a scheduled job that opens a pull request, so
the gateway reads a local file and a third-party schema change breaks a job rather than a
customer's `PUT`. Every floor change is then a dated, reviewable diff. The artifact and its
producer land with M2, when there is a runtime to read it; until then this section is the
specification for both.

**Direction of error.** Deliberately optimistic. A target is rejected only when it fails
the most optimistic candidate floor by a margin exceeding that floor's own variance,
derived from the published p50/p95 spread where one exists. A floor with no variance behind
it may inform the best-achievable value in a rejection but may never be the basis for one.
The reasoning is in ADR 0003: a too-optimistic floor surfaces as `unmet` two windows later,
while a too-pessimistic floor produces no traffic, no measurement, and no evidence we were
wrong. State the consequence plainly rather than letting a reader discover it — **at M2,
with no measured floors, latency targets are effectively never rejected at write time and
cost targets are.**

**Cost floors are a function of workload shape.** A single model carries a ~10x spread
across input versus output rates, context-length tiers, cache read/write, batch and
priority service tiers, and inference geography. The cheapest achievable rate is
well-defined and unachievable by any real workload, so a naive cost floor is maximally
optimistic in a way that guarantees `unmet`. At write time there is no traffic, so the floor
is computed against a stated-or-defaulted shape and the `422` must disclose the assumption
("assuming 1:3 input:output under 200k context, standard tier"). Once the workload has
traffic, its observed shape replaces the assumption and feeds the `unmet` evaluation. A
customer may state the shape; requiring it would put a modeling exercise in front of someone
who wants to state one number.

**When a floor proves wrong.** This is the one path on which the specification's promise —
infeasibility is reported, never silently best-effort — can fail without anyone noticing,
because a bad floor presents to the customer as ordinary provider degradation. There is
still no third state: ADR 0001's two-state vocabulary is load-bearing across the status
schema, the notification trigger, and the routing seam's return type, and a third state pays
that cost again to describe a defect in *our* data rather than a property of the customer's
workload. Instead, three mechanisms:

- **A decision receipt.** Each accepted write commits, in the same transaction as the
  document, the floor values and provenance the check ran against, keyed by document
  version. This makes the correction check a comparison rather than a reconstruction of a
  past decision from logs — the same objection this document already raises against
  reconstructed binding reasons. It lives in a sibling table in the target store, never
  inside the target document: the document is the customer's statement of intent and a
  whole-document `PUT`, so fields they did not author must not appear in it.
- **A flag on the status resource.** A correction never invalidates a live document. The
  workload keeps routing and the target stays in force; the status resource reports that the
  target was accepted against a floor since corrected, and would not be accepted on current
  data. The customer decides whether to rewrite. Nothing but a customer write may change the
  validity of the document specified as their single source of truth.
- **A notification, but only for the sharp case.** A workload *already* `unmet` on a
  dimension whose corrected floor now exceeds its target. That is the case where the
  customer is watching what they believe is provider degradation and is in fact watching us
  having told them wrong. Fanning out a signed post per touched workload on every routine
  refresh was rejected — it reintroduces exactly the notification volume the bounded-retry
  design exists to prevent.

**What genuinely remains unresolved.** A cold-start floor is trusted, not verified: we have
no way to validate a `third_party` floor against ground truth for a model we never route to,
because the only thing that would validate it is the traffic whose feasibility we are trying
to decide. That sentence is the residue of what this document previously called its weakest
assumption.

## Durability and the target store (proposed)

Resolved by [#13](https://github.com/hoomji/henry-ai-router/issues/13); the concurrency
choice and its trade-off are recorded in ADR
[`0002`](../adr/0002-durable-target-store-with-cross-process-concurrency.md). The **target
store** is SQLite in WAL mode via Node's built-in `node:sqlite` — one file, four tables
(the fourth being decision receipts, added by #12), zero runtime dependencies. It requires Node 24 or newer, which raises the engines floor
from the 20 recorded in the ExecPlan's Decision Log.

Behavior 1 produces three pieces of state, and they get three different answers rather
than one store-everything default:

| State | Durability | Why |
|---|---|---|
| Target document | Committed before ack: `PUT /v1/targets` returns `200` only once the write is durable | Customer-authored and unrecoverable if lost. A version the customer has seen but the store has not committed makes "single source of truth" untrue. Writes are rare, human-driven, and off the data path, so the latency is affordable. |
| Measurement windows | Not durable. In-memory, rebuilt from traffic; a per-window *summary* is persisted at each window close, best-effort | Raw samples are derived and cheap to rebuild, and persisting a hot rolling window would put the store on the request path. Summaries exist only so several processes can be merged. |
| `unmet` state and its two-window counters | Persisted at window close, best-effort, tolerating loss of at most the last window | Customer-visible state reported on three surfaces. Nothing acks it, so committed-before-ack buys nothing; losing one window delays an entry by roughly five minutes and never produces a wrong state. |
| Decision receipts | Committed in the same transaction as the document write, in a sibling table keyed by document version | The receipt is what makes a later floor correction a comparison rather than a reconstruction (#12). Same-transaction because a committed document without its receipt is a decision we cannot audit. Pruned when its document version is superseded. |
| Notification signing secret | Not in the store at all — it stays in the config surface | A credential with a different lifecycle. In the store, every backup, dump, and document read path becomes a secret-handling path. |

**Restart.** The state machine survives; the samples do not. `unmet` and its counters are
restored at boot, so a deploy no longer resets a customer's target state. Two consequences
follow and are customer-visible. First, a workload can be `unmet` *and*
`insufficient_data` at the same time until its window refills — coherent, because "no mix
*has* held the target" is a claim about the past while "we cannot measure it right now" is
a claim about the present, but the status resource must be able to represent both.
Second, counters older than about two windows of wall-clock downtime are discarded while
the `unmet` flag itself is kept: a half-finished count from three days ago measures
nothing and must not combine with one fresh window to force an entry, whereas silently
clearing the flag while nobody was watching is the harm this decision exists to remove.
Leaving `unmet` always happens the specified way — two consecutive held windows.

**Concurrency.** Several gateway processes on one host may write. Optimistic concurrency
is enforced by the store's transactional compare-and-set rather than by a single-writer
assumption, which serves both the `409` on the document and notification de-duplication
with one primitive. `409` is terminal: the gateway never retries a rejected write for the
client, and `PUT` is a whole-document replace, so there is no retry loop in our contract
for two management clients to livelock in. Field-level merge across workloads would let a
dashboard edit and a configuration deploy both succeed, but merge semantics over a
document with cross-workload validation is a design of its own and is not taken here.

**Windows under several processes.** Each process keeps its own rolling window in memory
and writes a summary at window close, tagged with a process identifier and the
window-close timestamp. `targets/unmet.ts` evaluates over the merged summaries whose close
falls in the current window and prunes older rows as it goes, so a crashed or scaled-down
process's contribution ages out within one window with no liveness detection, heartbeat,
or leader election. Two rules follow that a reader will otherwise get wrong: the sample
floor is workload-wide across merged summaries rather than per-process, and while a
process is down the merged count can fall below that floor and report `insufficient_data`
— correct behavior that looks like a regression if the merge rule is not known.

**Notifications.** The `unmet` transition is itself a compare-and-set; the process that
wins it sends the notification and the others observe the version move and stay silent, so
N processes produce one notification. Retries do not survive a restart — the status
resource is authoritative, and a persisted retry queue would reintroduce the
unbounded-queue-during-an-incident failure this design already rejected. A transition
first *discovered* after a restart notifies normally: it is a real transition, and
suppressing it would let a deploy swallow an `unmet` entry.

**Reads on the data path.** The store is never read synchronously while serving a request.
`server.ts` routes on an in-memory copy loaded at boot and refreshed by polling the
document version on a short interval (proposed 5 seconds), swapping the copy when it
moves. A store outage therefore degrades only the control plane — writes fail, status may
go stale — and cannot touch forwarding. This is the same argument that makes `management/`
a sibling of `server.ts`, extended to the store. The consequence to state plainly: a
target change takes effect within about five seconds, and `PUT` returning `200` means
*committed*, not *in force in every process*.

**Boot with an unreadable or corrupt store.** The process starts anyway: it serves the
data path as pure passthrough to `UPSTREAM_BASE_URL`, fails management reads and writes
with `503`, and reports the condition loudly. It never synthesizes an empty document,
because an empty document is indistinguishable from a customer who has stated no targets —
a corruption would then look like deliberate configuration and the customer would never
learn their targets had stopped being applied. Refusing to boot was considered and
rejected: a corrupt control-plane file must not stop customer traffic from reaching a
provider, which is the fail-open boundary applied to our own startup.

## Config surface (proposed)

M1: exactly two environment variables, `UPSTREAM_BASE_URL` and `FORCE_ROUTER_ERROR`.
M2 adds a JSON config file (path via `GATEWAY_CONFIG`) declaring providers
(`{ id, baseUrl, adapter }`), their capability floors, the notification endpoint and
secret, and the target store's file path (overridable by `GATEWAY_STORE_PATH`, following
the same environment-overrides-file rule, so M1 keeps exactly its two variables).
`config.ts` is the only module that reads the environment; everything else
receives parsed config as arguments, so config growth never leaks into routing or
adapters. Environment variables always override file values, keeping the tracer's
two-variable setup working forever.

Targets are deliberately **not** part of this config surface. They live in the target
document behind `PUT /v1/targets`, because #6 made that document the single source of
truth with optimistic concurrency — putting targets in a process-level config file too
would create exactly the second writer that versioning exists to prevent. The config file
says where the store lives; it never says what the targets are.

## Alternatives considered

- Adapters performing their own `fetch`: rejected — it welds I/O to the fastest-changing
  code and breaks data-path portability.
- An async `chooseProvider` that probes providers live: rejected — the Decision Log
  requires routing as a function of a snapshot; live probing belongs in stats collection.
- A web framework (Express/Fastify/Hono): rejected for the tracer — `node:http` plus
  global `fetch` keeps runtime dependencies at zero; revisit only with a Decision Log
  entry in the ExecPlan. Note M2's management surfaces raise the cost of this choice:
  routing, JSON body handling, and status codes must now be written by hand for several
  endpoints rather than one. Revisit if `management/api.ts` starts growing a router.
- Deciding `unmet` inside `chooseProvider`: rejected — a single call cannot know whether
  two windows have been missed, and giving the seam that memory would make it stateful,
  breaking the snapshot purity the Decision Log's portability claim depends on.
- A third infeasibility state for "our floor was wrong": rejected — ADR 0001's two-state
  vocabulary is load-bearing across three contracts, and the condition describes a defect
  in our data rather than a property of the customer's workload. It gets a receipt, a
  status flag, and a narrow notification instead.
- Polling the third-party capability source from the gateway at runtime: rejected — it
  puts a new outbound failure surface next to a customer's write path. The unmeasured
  tiers are a committed artifact refreshed by a scheduled job, so a schema change upstream
  breaks a job rather than a `PUT`.
- Re-validating and invalidating existing target documents when a floor is corrected:
  rejected — a background job that retroactively breaks a live configuration because *our*
  data changed is worse than the stale floor it fixes, and only a customer write may change
  the validity of their single source of truth.
- Serving management endpoints from `server.ts`: rejected — control-plane failures would
  share a fate with the forwarding path, contradicting the fail-open boundary.

## Failure modes and operational notes

Stub-upstream death mid-run surfaces as upstream errors passed through unchanged (the
gateway does not synthesize responses). Stats windows are in-memory and reset on restart,
so a restart drops every workload below its sample floor into `insufficient_data` until
the window refills. That is now only a measurement gap, not a state loss: per #13 the
`unmet` state and its counters are persisted and restored at boot, so a customer's target
state no longer resets on deploy. A workload is therefore `unmet` and `insufficient_data`
simultaneously for the first window after a restart — see *Durability and the target
store* for why that combination is correct rather than contradictory.

A store outage cannot affect forwarding, because the data path reads an in-memory copy and
never the store; a corrupt store at boot yields passthrough forwarding with a failing
management surface rather than a refusal to start. The remaining exposure is
control-plane: during a store outage a customer cannot change a target, and the status
resource may be up to one window stale.

Security: the tracer binds localhost and holds no credentials. M2 introduces the first
secret — the per-customer notification signing key — which lives in config, is never
logged, and is never returned by any management endpoint. Anything beyond that is future
work gated on the spec's open decisions.

## Evidence

2026-08-15, against M2. The four checks this document names, re-run over the full tree, and
what each found:

- **The tree matches the layout.** Yes — file for file, at the paths above, with every M2
  module present. Two files existed that this document had not named and that the layout
  above now records: `targets/service.ts` and `dev/simProvider.ts`. Recording them was the
  point of the re-check; a layout that quietly omits a module is a layout a reviewer cannot
  use to detect drift.
- **No inward imports.** Verified by search over `src/`. Nothing under `routing/`,
  `targets/`, or `providers/` imports `server.ts`, `management/`, or `node:http`; the only
  textual match in those directories is a comment in `providers/adapter.ts` describing the
  rule. `node:http` appears only in `server.ts`, `management/api.ts`, and the three `dev/`
  files. The declared concession holds exactly as declared: `targets/store.ts` is the sole
  file under `src/` that names `node:sqlite`.
- **`chooseProvider` returns a binding reason.** Now verified in content, not only as a
  type. With several candidates the seam populates `rejected` with per-provider,
  per-dimension reasons and reports the dimension that bound the decision;
  `gateway/test/chooseProvider.test.ts` exercises the populated cases that M1 could not,
  having had one candidate and therefore nothing to reject.
- **The M2 evidence artifact exists and passes.** `npm --prefix gateway run load` starts the
  simulated providers, warms up until every provider is genuinely measured, then drives two
  workloads whose targets differ. Four consecutive runs on 2026-08-15 all exited zero. The
  last reported the fast provider holding 92.0% of the split under the latency target and
  52.5% under the cost target — a 39.5 percentage-point shift — with blended cost moving
  $0.02776 to $0.01670 between the two. `npm --prefix gateway test` is green at 132 tests
  across 35 suites.

2026-08-15, against the completed connector and reservation ExecPlan. The same checks re-run
over the larger tree, plus the one this document could not previously make:

- **The tree matches the layout,** including `controlplane/`, `reservations/` and the three
  new `dev/` modules now recorded above.
- **The dependency rule holds with two declared concessions.** `targets/store.ts` is still
  the only file under `src/` naming `node:sqlite`; `node:http` appears only in `server.ts`,
  `management/api.ts`, `controlplane/api.ts` and the `dev/` files. `rankedList.ts` and
  `usageOutcome.ts` are pure.
- **`chooseProvider` kept its signature and its purity** through the reservation change, with
  term liveness resolved by the caller.
- **The gateway is demonstrably out of the request path.** `npm --prefix gateway run e2e`
  reported 7 of 7 checks on 2026-08-15: no chat-completion request in the gateway's access
  log, a target switch inside five seconds with the connector's acknowledgement recorded,
  connector-supplied token counts on the status resource, the sample application surviving
  the gateway being killed, the polling fallback detectable at `deliveryMode=poll,
  ackDelayMs=3067`, streaming time-to-first-byte 1070 ms against a 3084 ms stream, and
  `unmet` reached on connector reports alone with 0 in-path requests. `npm --prefix gateway
  test` is green at 203 tests across 61 suites and `npm --prefix connector test` at 32 tests
  across 11 suites.

Both limits below still apply unchanged, and one is worth restating in this context: check 7
above is what caught the measurement gap recorded under *The connector as a sibling runtime*.
Every unit test passed while that defect was live.

State moved to `Verified` on the strength of those four. Two limits belong next to the
claim rather than buried under it. All of it is simulated: no run has touched a real
provider, so every capability floor is unmeasured and the `measured` provenance tier is
empty in practice. And the continuity of that verification is bounded: since 2026-08-16,
[`.github/workflows/gate.yml`](../../.github/workflows/gate.yml) runs the gate and the
end-to-end job on every push and pull request, so these checks no longer depend on a person
remembering — but the checks cannot be made *required* on this repository's plan, so a red
run does not block a merge.

Revision note: 2026-08-15 — reconciled with the completed connector and reservation ExecPlan
([`../exec-plans/completed/2026-08-15-connector-and-reservation-aware-routing.md`](../exec-plans/completed/2026-08-15-connector-and-reservation-aware-routing.md)).
The layout gained `controlplane/` (`rankedList.ts`, `directives.ts`, `usageOutcome.ts`,
`api.ts`), `reservations/` (`document.ts`, `unaddressed.ts`), and three `dev/` modules. The
dependency rule now declares two concessions rather than one: `controlplane/api.ts` on
`node:http`, beside `targets/store.ts` on `node:sqlite`. The multi-tenancy non-goal sentence
that claimed a hardcoded customer key with no API surface was false and is corrected in
place; cohort multi-tenancy and per-customer measurement stay deferred. A new section records
the connector as a sibling runtime and, with it, the fact that connector-reported usage is
the only input the measurement windows have — the one thing in this design that was got
wrong, was invisible to unit tests, and is easy to break again. `chooseProvider` gained a
reservation preference while keeping its signature and purity, term liveness having been
resolved by the caller into the state snapshot. Nothing about the adapter contract, the
fail-open path, or the store's durability design changed.

Revision note: 2026-08-15 — reconciled with the M2 tree and moved State from
`Partially verified` to `Verified`. Two modules M2 built that this document had not named
joined the layout: `targets/service.ts`, with the dependency-rule argument that fixes where
it can live, and `dev/simProvider.ts`. The target-state routing section gained the two
lookbacks — a trailing three-window merge for what routing and the status resource report,
a single closed window for the `unmet` verdict — and the exploration rule that makes an
unmeasured provider preferred, which is why a split read before warm-up describes nothing.
The Evidence section was re-run over the full tree rather than edited. Nothing about the
adapter contract, the fail-open path, or the store design changed.

Revision note: 2026-08-15 — resolved
[#12](https://github.com/hoomji/henry-ai-router/issues/12) (capability catalogue) on the
evidence of [#11](https://github.com/hoomji/henry-ai-router/issues/11). Added *The
capability catalogue*, which replaces the note calling the catalogue this document's
weakest assumption; the residue is narrowed to one sentence about cold-start floors being
trusted rather than verified. The floor's key changed from per-model to
`(model, host, region, service_tier)`, feasibility gained an abstention and an optimistic
margin, the `422` gained floor provenance and age, the store gained a decision-receipts
table, and three rejected alternatives were added. Recorded in ADR
[`0003`](../adr/0003-provenance-tiered-capability-catalogue.md), which amends ADR
[`0001`](../adr/0001-declaration-time-vs-observed-infeasibility.md) in part.

Revision note: 2026-08-15 — resolved
[#8](https://github.com/hoomji/henry-ai-router/issues/8) (behavior sequence). Three changes,
all of them corrections to things this document said that the sequencing decision made half
true. The multi-tenancy/authn non-goal split in two: authn and a real customer key arrive with
the *connector*, immediately after the tracer, while cohort multi-tenancy stays with behavior
3. The streaming deferral split the same way: pass-through ships with the connector, chunk
transform stays deferred on the adapter contract. And the routing seam gained the note that
it also produces the pushed *ranked list*, which is the payoff of its purity constraint and
the reason no second ordering routine exists. Recorded in ADR
[`0006`](../adr/0006-routing-authority-stays-gateway-side.md).

Revision note: 2026-08-15 — resolved
[#13](https://github.com/hoomji/henry-ai-router/issues/13) (durability). Added *Durability
and the target store*; persistence left the non-goal list entirely and deployment topology
became a partial exception; `targets/store.ts` joined the layout; the config surface
gained the store path; the failure-modes note that in-memory windows "must not survive to
a real customer" was replaced by the decision itself. The concurrency choice is recorded
in ADR [`0002`](../adr/0002-durable-target-store-with-cross-process-concurrency.md).

Revision note: 2026-08-15 — reconciled with
[#6](https://github.com/hoomji/henry-ai-router/issues/6), which specified behavior 1 in
full after this document was drafted. Changed: the routing seam's return type, the target
vocabulary, per-workload measurement windows, two new module groups (`targets/`,
`management/`), the config surface, persistence moving off the non-goal list, and three
added rejected alternatives. The fail-open path and adapter contract are unchanged.
