# Stand up the provider-risk gateway from spec to first working tracer

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` current as work proceeds. Follow the repository's ExecPlan guidance at `PLAN.md` (repository root).

## Purpose / Big Picture

Today this repository contains only documentation: a product specification at
`docs/product-specs/provider-risk-management-gateway.md` describing an AI router/gateway
that sells provider risk management (target-state routing, strain-triggered interception,
collective fatigue-aware routing, reservation-aware routing, semantic-fidelity prompt
translation), and the harness around it. Nothing runs.

After this plan, a person can start a minimal gateway process locally, send it an
OpenAI-style chat-completion HTTP request, and watch it forward the request to a
configured upstream provider — and watch it *fail open* (traffic still reaches the
provider path) when the gateway's routing logic errors. That is the thinnest observable
slice of the spec's core promise: the gateway must never be a worse single point of
failure than the providers it manages. The second milestone grows the first product
behavior (target-state routing) on top of this tracer.

The gateway is written in TypeScript running on Node.js, inside this repository. Both
choices are already made by the repository owner and are recorded in the Decision Log
below; no milestone is spent deciding them.

## Progress

- [x] Scaffold the runnable gateway with a fail-open pass-through proxy (M1).
      2026-08-15 — Done and verified. `gateway/` exists with the three seams separate,
      `npm --prefix gateway test` passes 9 tests, and the curl transcript in *Artifacts and
      Notes* shows both the normal response and the fail-open header. `AGENTS.md`,
      `ARCHITECTURE.md`, and `docs/harness/manifest.yaml` no longer deny a runtime exists.
- [x] Implement target-state routing against simulated providers, decision surface and
      HTTP surfaces both (M2).
      2026-08-15 — Done and verified. All eight of M2's work items landed: the target
      document and its closed vocabulary (`targets/document.ts`), rolling measurement
      windows merged across processes (`routing/stats.ts`), target-state routing with
      relaxation and a binding reason (`routing/chooseProvider.ts`),
      `infeasible_by_declaration` against a provenance-tiered capability catalogue
      (`providers/capabilities.ts`, `targets/feasibility.ts`), the two-window `unmet` state
      machine (`targets/unmet.ts`), the four delivery surfaces (`management/api.ts`,
      `management/notify.ts`, plus the two headers in `server.ts`), the durable SQLite store
      with cross-process compare-and-set (`targets/store.ts`), and the load script
      (`dev/simProvider.ts`, `dev/load.ts`). `npm --prefix gateway test` passes 132 tests;
      `npm --prefix gateway run load` passes three consecutive runs; `python
      scripts/check.py` passes 3 of 3. The completion criterion and all six verification
      steps have named artifacts in *Artifacts and Notes*.

Add a timestamped entry at every stopping point. This checklist must state the actual
state of the work, not the originally intended sequence.

## Surprises & Discoveries

- 2026-08-15 — **A routing engine that only picks what it has already measured cannot
  discover anything.** M2's first load run sent 100% of traffic to one provider under
  *both* a latency target and a cost target, and the load script correctly refused to call
  that evidence. The cause was a feedback loop rather than a bug in any one module: at cold
  start every provider reports `insufficient_data`, the tie-break picked the
  lexicographically first provider, that provider accumulated samples and became measured,
  and the other received zero requests — so it stayed unmeasured, and therefore unchosen,
  forever. A provider that is never chosen can never be measured, and a provider that can
  never be measured can never be chosen. The fix is recorded in the Decision Log; the
  reason it is recorded rather than quietly patched is that "prefer the provider we have
  measured" looks locally sensible and is globally self-defeating, so a future reader will
  be tempted to reintroduce it.
- 2026-08-15 — **The measurement window answers two different questions and needs two
  different lookbacks.** Judging the `unmet` state over a trailing multi-window merge
  breaks the deliberate symmetry of the two-window exit, because a recovered workload keeps
  being judged on the windows it already recovered from. Judging the *data path* over a
  single closed window is equally wrong in the other direction: the evidence evaporates
  moments after it is gathered, every provider falls back to `insufficient_data`, and
  exploration re-triggers on traffic that was just measured. `targets/service.ts` now
  computes both and uses each where it belongs.
- 2026-08-15 — **A capability floor for a simulated provider must not decay.** The floors
  carry a provenance and a TTL, which is right for a measured floor on a real provider. The
  simulated providers inherited the same six-hour TTL, so two weeks after the catalogue's
  epoch every sim floor was stale, the declaration-time check abstained on everything, and
  `infeasible_by_declaration` could only ever fire inside tests pinned to that epoch. The
  sim entries are now exempt from decay while the real-model entries keep realistic TTLs —
  which is what keeps *both* the rejection path and the abstention path demonstrable.
- 2026-08-15 — The load script earned its keep by failing. It caught both the cold-start
  trap and a later run-to-run flip in the split direction, and neither would have been
  visible from the test suite, which was fully green throughout.

## Decision Log

- Decision: Target-state routing (required behavior 1 in the product spec) is the first
  product behavior milestone, after the fail-open tracer.
  Rationale: It is the spec's clearest differentiator, testable entirely against
  simulated providers, and does not depend on the cross-customer network effect
  (behavior 3) or pricing model questions (behaviors 2 and 4) that remain open product
  decisions.
  Date/Author: 2026-08-14 / Claude (planning)

- Decision: The gateway implementation lives in this repository, under a new top-level
  `gateway/` directory.
  Rationale: The harness that governs this work — the product spec, this plan, the
  validation and gate commands — is already here, and a separate repository would
  duplicate it and split review. The repository owner confirmed the choice directly, so
  it is no longer an open question gating implementation.
  Date/Author: 2026-08-14 / henry.tran@uniblock.dev (confirmed), recorded by Claude

- Decision: M2 ships a real durable target store rather than an in-memory stand-in, and
  the store is designed for concurrent writer processes from the start. The engines floor
  moves from Node 20 to Node 24, and the store is SQLite in WAL mode through Node's
  built-in `node:sqlite`, keeping runtime dependencies at zero.
  Rationale: Grilling ticket [#13](https://github.com/hoomji/henry-ai-router/issues/13)
  resolved durability. M2's acceptance criteria are about customer-visible target state,
  and a state machine that resets on restart cannot demonstrate them honestly. Concurrency
  is designed in rather than deferred because a single-writer design would have to be
  undone rather than extended — measurement windows, the sample floor, `unmet` evaluation,
  and notification de-duplication all take a different shape under several writers. The
  full trade-off, including why not Postgres and why not `better-sqlite3` on Node 20, is
  in ADR
  [`0002`](../../adr/0002-durable-target-store-with-cross-process-concurrency.md).
  Date/Author: 2026-08-15 / henry.tran@uniblock.dev (confirmed), recorded by Claude

- Decision: The gateway is written in TypeScript on Node.js (version 24 or newer), and is
  structured so its request-forwarding path can later be reimplemented in Rust or Go
  without rewriting the routing policy.
  Rationale: This gateway is an HTTP reverse proxy that streams model responses back to
  callers. Nearly all of its time is spent waiting on an upstream provider, so what
  matters is holding many open connections cheaply, adding little latency of our own, and
  absorbing provider API changes quickly — not raw computation speed. TypeScript is the
  best available balance of those: every major model provider ships a first-class
  TypeScript SDK alongside Python, JSON is the native data shape of the whole problem,
  the per-request cost is roughly two to four times lower than Python's, and it deploys to
  ordinary servers and edge runtimes alike. Python was the runner-up on ecosystem alone
  but costs materially more CPU per proxied request; Rust and Go were rejected for *now*
  because they would require hand-maintaining every provider dialect adapter, which is the
  fastest-changing part of the system, in exchange for an infrastructure saving nobody has
  yet measured. The realistic future is a split rather than a rewrite — routing policy and
  provider adapters stay in TypeScript, the proxy data path moves to Rust or Go — which is
  the shape comparable gateways converge on. Revisit when the gateway's own CPU cost
  becomes a visible share of cost of goods sold, when latency added by our layer exceeds
  roughly 10 milliseconds at the 99th percentile, or when token counting or guardrail work
  moves onto the synchronous request path in volume. To keep that future cheap, M1 and M2
  must hold three constraints: provider adapters are pure request/response translation with
  no web-framework types leaking into them, a routing decision is a function of a snapshot
  of provider state rather than of live input/output, and the forwarding path stays thin
  enough to be reimplemented against the same adapter contract.
  Date/Author: 2026-08-14 / henry.tran@uniblock.dev (confirmed), recorded by Claude

- Decision: M2 implements the spec's full target vocabulary and its customer-facing HTTP
  surfaces, and is no longer labeled *Prototyping*.
  Rationale: Grilling ticket [#6](https://github.com/hoomji/henry-ai-router/issues/6)
  resolved behavior 1 in full — workloads, three dimensions, an objective, a priority
  order, a hard dimension, and two distinct infeasibility states — and the repository owner
  chose to build all of it in M2 rather than keep M2 a narrow subset, including the
  management API, status resource, notification, and response header. Publishing those
  contracts is incompatible with the *Prototyping* label, whose promise was that the
  milestone could be discarded on evidence; keeping the label while shipping customer-facing
  HTTP would be a false promise. The escalation criterion that made the prototype
  meaningful (oscillation above 20% forces a redesign) is retained as an escalation
  trigger instead.
  Date/Author: 2026-08-15 / henry.tran@uniblock.dev (confirmed), recorded by Claude

- Decision: M1 and M2 are relabeled rather than reworked. M2 delivers behavior 1's
  *decision engine*, not behavior 1 as a customer receives it; M1's in-path forwarding
  server is behavior 2's future interception path, not a temporary scaffold. Nothing in
  either milestone is discarded and no work in them changes.
  Rationale: Grilling ticket [#8](https://github.com/hoomji/henry-ai-router/issues/8)
  settled that the gateway is out of the request path in normal operation, so target-state
  routing reaches a customer as a ranked list pushed to a *connector* — the
  customer-installed component that calls providers directly — rather than as the
  per-request choice these milestones implement. That could have meant M2 was partly wrong.
  It does not, because `chooseProvider` is pure over a state snapshot: the same function
  that picks a provider per request computes the ranked list to push. What changes is only
  what these milestones are understood to deliver, and an implementer finishing M2 today
  would otherwise reasonably believe behavior 1 was shippable. It is not until the
  connector exists. Routing policy stays gateway-side per ADR
  [`0006`](../../adr/0006-routing-authority-stays-gateway-side.md).
  Date/Author: 2026-08-15 / henry.tran@uniblock.dev (confirmed), recorded by Claude

- Decision: The work after this plan — the connector, then reservation-aware routing
  (behavior 4) — lives in its own ExecPlan at
  [`2026-08-15-connector-and-reservation-aware-routing.md`](2026-08-15-connector-and-reservation-aware-routing.md),
  not as further milestones here.
  Rationale: This plan's stated destination is M1 and M2, and its Plan of Work puts
  behaviors 2–5 out of scope. Extending it would make its own scope untrue. The sequencing
  decision itself (#8) is recorded in that plan's Decision Log and in the product spec's
  *Behavior sequence and deferrals* section.
  Date/Author: 2026-08-15 / henry.tran@uniblock.dev (confirmed), recorded by Claude

- Decision: `chooseProvider` returns a binding reason alongside the chosen provider.
  Rationale: The spec requires both infeasibility reports to name why each candidate
  provider was rejected. A reason reconstructed from logs after the fact is not
  trustworthy, so the requirement is a constraint on the routing seam's return type rather
  than a logging concern. See `docs/adr/0001-declaration-time-vs-observed-infeasibility.md`.
  This changes the signature recorded under "Interfaces and Dependencies" below.
  Date/Author: 2026-08-15 / Claude (planning), per #6

- Decision: The gateway carries one development dependency beyond `typescript` —
  `@types/node` — and still zero runtime dependencies.
  Rationale: `node:http` and the global `fetch` do not typecheck without it, so the
  alternative was to weaken `strict` or hand-write ambient declarations for the standard
  library. The constraint this plan actually protects is the *runtime* dependency count,
  which is unchanged: nothing is installed on the path a request travels. Recorded here
  rather than waved through because the plan asked for any dependency to be argued.
  Date/Author: 2026-08-15 / Claude (M1 implementation)

- Decision: Among candidates that satisfy every stated ceiling, a provider whose
  *objective* dimension is `insufficient_data` is preferred over one with a measured value.
  Rationale: the opposite rule — prefer what we have measured — makes the engine unable to
  discover anything, because a provider that is never chosen never accumulates the samples
  that would let it be chosen. Gathering the evidence *is* the objective while the evidence
  does not exist. The cost is bounded and self-terminating: once a provider clears the
  sample floor it competes on merit, so exploration costs at most one sample floor of
  requests per provider per window rather than a standing tax. The visible consequence is
  that a split is never 100/0 — a small residual share keeps checking whether our own
  measurements are still true — and the load script says so in its output rather than
  leaving a reader to mistake it for a defect.
  Date/Author: 2026-08-15 / Claude (M2 implementation), after the load script falsified the
  previous rule

- Decision: A workload's `objective` may name a dimension it states no ceiling for.
  Rationale: the spec lists the objective as its own element of a target, separate from the
  dimensions, and "hold p95 under 900 ms and minimize cost" is the canonical target rather
  than an edge case — requiring the objective to also be a stated ceiling would force a
  customer to invent a ceiling for the very quantity they are asking the gateway to
  minimize. The vocabulary stays closed: an objective outside the three dimensions is still
  rejected. `priority` remains a permutation of the *stated* dimensions and `hard` must
  still be one of them, because only a stated ceiling can yield or be breached.
  Date/Author: 2026-08-15 / Claude (M2 implementation)

- Decision: `targets/service.ts` exists, and is not in the design doc's proposed layout.
  Rationale: something has to own the store handle, the in-memory document copy and its
  polling refresh, the rolling windows, and the `unmet` machine, and both the data path and
  the management surfaces need it. It lives under `targets/` rather than `management/`
  because nothing under `targets/` may import `management/`, which is also why it delivers
  notifications through an injected callback instead of importing `management/notify.ts`.
  The dependency rule points one way and a convenience import would have been the first
  crack in it.
  Date/Author: 2026-08-15 / Claude (M2 implementation)

- Decision: Capability floors for the simulated providers do not expire; floors for real
  models keep realistic TTLs.
  Rationale: a floor's TTL models the decay of a *measurement*, and a simulator's
  characteristics do not decay. With a shared six-hour TTL every sim floor was stale within
  a day of the catalogue's epoch, the declaration-time check abstained on everything, and
  `infeasible_by_declaration` became unreachable outside tests pinned to that epoch. Keeping
  real-model TTLs realistic is what keeps the abstention path demonstrable, so the catalogue
  now exercises both halves of the spec's requirement rather than collapsing into one.
  Date/Author: 2026-08-15 / Claude (M2 implementation)

- Decision: The data path and the `unmet` state machine read the measurement store over
  different lookbacks — a trailing three windows for what routing and the status resource
  report, and only the window that just closed for the state machine's verdict.
  Rationale: they answer different questions. The spec's window is "5 minutes or 200
  requests, whichever spans longer", so a trailing merge is what the reported measurement
  means; but folding several windows into the *verdict* would keep judging a recovered
  workload on the windows it recovered from and break the deliberate symmetry of two windows
  in, two windows out.
  Date/Author: 2026-08-15 / Claude (M2 implementation)

## Outcomes & Retrospective

2026-08-15 — Both milestones are complete. A person can start the gateway, watch a request
be forwarded, watch it still be forwarded when routing is broken, state a target over a
workload, and watch the provider mix move because of that target and nothing else.

What this plan does **not** entitle anyone to claim:

- **Behavior 1 is not shippable to a customer.** M2 delivers its decision engine. Reaching a
  customer means the connector pushing a ranked list, which is the successor plan's work
  ([`2026-08-15-connector-and-reservation-aware-routing.md`](2026-08-15-connector-and-reservation-aware-routing.md)).
- **All proof is simulated.** Two stub providers with injected latency and cost. No provider
  credentials, no deployment target, no real-provider run. The capability catalogue's
  realistic entries are plausible numbers, not measurements.
- **The repository gate is not runtime evidence.** `python scripts/check.py` validates
  setup, harness consistency, and Markdown links. The gateway's own suite is a separate
  command, and there is still no CI running either.
- **The `success_rate` dimension is measured but never exercised end to end.** It is
  classified correctly on the data path and honored by routing, and the simulated providers
  can inject errors, but no verification artifact drives a workload to breach it. The two
  dimensions with named artifacts are `p95_ms` and `cost_per_1k_tokens_usd`.
- **Internal retries and failovers do not exist yet.** `success_rate` is defined as the
  share of requests that got a usable response *after* all internal retries and failovers,
  and the classification honors that definition — but M2 performs no retry, so today the
  definition and the behavior coincide only because there is nothing to absorb. When retry
  lands, the measurement is already the right shape.

What went well, and is worth repeating: the load script was written to exit non-zero when
its own claim fails, and it caught two real defects — a cold-start feedback loop that made
target-state routing inert, and a lookback choice that made the status resource report
`insufficient_data` for a workload that had just served traffic. Neither was visible to the
test suite, which was green throughout. An artifact that cannot fail is not evidence.

One harness observation worth keeping, because retiring a plan will happen again: moving
this file from `active/` to `completed/` broke references of two different kinds, caught by
two different checkers. The Markdown links were caught by the link checker; a stale pointer
in a YAML evidence field in `docs/harness/manifest.yaml` was invisible to it and was caught
only by `harness-validate`. The link check passed while the gate failed. Completing a plan
therefore means running the *full* gate, not the link check, and `grep -rn "exec-plans/active/"`
across both `.md` and `.yaml` is the cheap sweep that finds the rest.

The escalation trigger this milestone carried — oscillation of the split above 20% between
consecutive windows forcing a redesign before damping — was not hit. The observed movement
is exploration on an unmeasured provider, which is bounded by the sample floor and
self-terminating, not an unstable control loop. If a future run shows the split swinging
between consecutive windows on providers that are *both* measured, that is the trigger and
it needs the redesign, not a damping term.

## Context and Orientation

This repository (`henry-ai-router`) is documentation-only today. The authoritative files
are:

- `AGENTS.md` — repository guidance and command list. Commands: setup
  `python scripts/setup.py`; harness validation `python scripts/harness-validate.py .`;
  full gate `python scripts/check.py`. The interpreter is `python` (not `python3`) on the
  maintainer's machine. These Python scripts are the *harness* — they validate
  documentation — and are unrelated to the gateway's own language; they stay in Python.
- `ARCHITECTURE.md` — the component map and the dependency rules between them, including
  the seam rule inside `gateway/` that this plan's Decision Log depends on. ADRs live at
  `docs/adr/NNNN-short-slug.md` and record product and design decisions; where the
  implementation lives and what language it is written in are recorded in this plan's
  Decision Log instead;
- `docs/product-specs/provider-risk-management-gateway.md` — the product specification
  this plan implements toward. Its acceptance criteria include a fail-open boundary
  ("with the gateway down, customer traffic still reaches the configured provider") and
  target-state routing ("a customer can state a latency/cost target and observe the
  gateway change provider mix... without a routing rule").
- `docs/exec-plans/index.md` — this plan must stay listed in its Active table until
  completed.

Terms used below: a *gateway* is an HTTP service that sits between a customer application
and AI model providers, receiving the customer's model API calls and forwarding them to a
chosen provider. *Fail-open* means that when the gateway's own decision logic fails, the
request is still forwarded along a default path instead of being dropped. A *tracer* is
the smallest end-to-end slice that proves the architecture works before features are
added. *Target-state routing* means the customer supplies a goal (for example, p95
latency below a threshold and monthly cost below a budget) and the gateway itself picks
which provider serves each request so the goal keeps holding. *Node.js* is the runtime
that executes JavaScript outside a browser; *TypeScript* is JavaScript with a type
checker, compiled to JavaScript by the `tsc` compiler before Node runs it.

Two questions the product spec lists as open are already resolved and must not be
reopened by an implementer: which behavior comes first (target-state routing, per this
plan's Decision Log) and where the implementation lives and in what language (this
repository, TypeScript on Node, per this plan's Decision Log). The spec's remaining open
questions — the pricing model, and the cross-customer signal-sharing agreement — are out
of this plan's scope.

One thing an implementer must understand about what these two milestones are for. In the
finished product the gateway is **not** in the request path during normal operation: a
*connector* installed at the customer's call site calls providers directly and obeys a
ranked list the gateway pushes to it. That connector does not exist yet and is not built
here. So M2 delivers behavior 1's decision engine — the target vocabulary, the measurement
windows, the two infeasibility states, and the routing function that produces a decision —
while the in-path HTTP server M1 builds is the shape the gateway takes later during an
*interception window* (spec behavior 2), when it legitimately is in the path. Finishing
this plan does not make behavior 1 shippable to a customer; it makes it demonstrable. See
the Decision Log and
[`2026-08-15-connector-and-reservation-aware-routing.md`](2026-08-15-connector-and-reservation-aware-routing.md).

## Acceptance Evidence

- Fail-open boundary: with the gateway running and its routing logic forced to error
  (via a test flag), an HTTP chat-completion request still returns an upstream response.
  Proven by the M1 verification transcript.
- Target-state routing: with two simulated providers whose latency/cost differ, setting a
  target shifts traffic distribution measurably without any routing rule being
  configured. Proven by the M2 test run output.
- Runtime proof beyond simulation (real providers) is unavailable in this repository
  today; the prerequisite is provider credentials and a deployment target, both out of
  scope for this plan.

## Milestones

### M1 — Runnable gateway tracer with fail-open pass-through

Goal: the first startable runtime. A minimal HTTP service in TypeScript exposing
`POST /v1/chat/completions`, forwarding the request body to a configured upstream base
URL, and returning the upstream response unchanged.

Work: create `gateway/` at the repository root containing a `package.json` (name
`gateway`, `"type": "module"`, engines Node >= 24), a `tsconfig.json` targeting a modern
Node module setting, and `src/`. Prefer Node's built-in `node:http` server and the global
`fetch` for the upstream call so the tracer starts with zero runtime dependencies; the
only expected development dependency is `typescript` itself. Any additional dependency
must be recorded in the Decision Log with rationale before it is added.

Inside `src/`, keep three seams separate, because the Decision Log's language choice
depends on them staying separate:

- `src/providers/` — one adapter per upstream, each a pure function pair translating an
  incoming request into an upstream request and an upstream response back. No server or
  framework types appear here. M1 ships a single passthrough adapter.
- `src/routing/chooseProvider.ts` — exporting
  `chooseProvider(request: GatewayRequest, state: ProviderState): Provider`. It takes a
  snapshot of provider state as an argument and performs no input/output of its own. In
  M1 it returns the sole upstream; M2 replaces its body.
- `src/server.ts` — the HTTP surface and the fail-open wrapper: if `chooseProvider`
  throws, forward to `UPSTREAM_BASE_URL` anyway and set the response header
  `x-gateway-failopen: true`.

Configuration is two environment variables: `UPSTREAM_BASE_URL`, and `FORCE_ROUTER_ERROR=1`
which makes `chooseProvider` throw so fail-open is demonstrable. Add a stub upstream
server under `gateway/src/dev/stubUpstream.ts` — a tiny HTTP server returning a canned JSON
completion — so the tracer is testable with no provider credentials. Add npm scripts
`build` (`tsc`), `start`, `stub`, and `test`.

Update `AGENTS.md`'s command list with the build, start, and test commands, and update
`docs/harness/manifest.yaml` so `commands.start` is the real start command and the
`startable_runtime` capability moves from `missing` to `verified` with the evidence that
proves it.

Completion criterion: from a clean checkout, the documented commands install, build, start
the stub upstream and the gateway, and a `curl` to the gateway returns the stub's
completion both normally and with `FORCE_ROUTER_ERROR=1` (the latter carrying
`x-gateway-failopen: true`).

Verification: from the repository root, run:

    npm --prefix gateway install
    npm --prefix gateway run build

Start the stub upstream and the gateway using the scripts recorded in `AGENTS.md`, then in
another terminal:

    curl -s -D - -X POST http://localhost:8080/v1/chat/completions -d "{\"model\":\"any\",\"messages\":[]}"

Expect: HTTP 200 with the stub's canned JSON body; with `FORCE_ROUTER_ERROR=1` set on the
gateway process, the same request returns HTTP 200 plus the `x-gateway-failopen: true`
header. Then run `python scripts/harness-validate.py .` and expect it to pass with the
manifest's new start command, and `python scripts/check.py` for the full gate.

Rollback and recovery: the milestone is additive (new directory, doc edits);
revert the commit to recover. Steps are idempotent — reinstalling, rebuilding, and
restarting the processes are always safe.

Escalate when: the fail-open semantics conflict with a security requirement not yet
written down, or a runtime dependency beyond the Node standard library appears necessary
and the trade-off is not obvious.

### M2 — Target-state routing against simulated providers

Goal: implement the spec's behavior 1 as specified in
`docs/product-specs/provider-risk-management-gateway.md`, section "Target-state routing in
detail", against simulated providers. This milestone covers both the decision surface (the
target vocabulary and the two infeasibility states) and the delivery surface (the
management API, the status resource, the notification, and the response header). It is
**not** labeled Prototyping: shipping customer-facing HTTP contracts makes it not
discardable on evidence, which is what that label promised. See the Decision Log.

Two stub providers with different simulated latency, per-request cost, and error injection
drive the whole thing; no provider credentials are needed.

Work, in the order it should land:

1. **Target document and its schema.** A per-customer document holding named workloads.
   Each workload carries: `allowed_models` (required, non-empty); zero or more of the
   three dimensions `p95_ms`, `cost_per_1k_tokens_usd`, `success_rate`; one `objective`
   naming a dimension or `none`; an optional `priority` order over the stated dimensions,
   defaulting to reverse declaration order; and an optional single `hard` dimension,
   defaulting to none. Every customer has a `default` workload. Reject unknown dimension
   names rather than ignoring them — the vocabulary is closed on purpose.

2. **Measurement.** Per workload and provider, maintain a rolling window: trailing 5
   minutes **or** 200 requests, whichever spans longer. Latency is provider-attributable
   (time to last byte from the upstream), not end-to-end. `success_rate` counts a request
   as successful when it got a usable response after all internal retries and failovers,
   so a re-routed 429 or 5xx is a success; malformed customer requests are excluded from
   the denominator entirely. Below the sample floor the dimension's value is
   `insufficient_data`, a distinct value — never a percentile over a handful of requests.

3. **Routing.** Extend `chooseProvider` to consult that window through the `ProviderState`
   snapshot, never reading input/output inside the function. It selects the provider that
   holds every ceiling while minimizing the objective. When no candidate holds every
   ceiling, the lowest-priority ceiling yields; a `hard` dimension never yields, and the
   request fails instead.

   **The return type changes**: `chooseProvider` must return the chosen provider *and* a
   binding reason — which dimension bound the decision, and why each candidate was
   rejected. The spec requires both reports to be diagnoses, and a reason reconstructed
   from logs after the fact is not one. Record the new signature under "Interfaces and
   Dependencies" when it is written.

4. **`infeasible_by_declaration`.** On every write of the target document, check
   synchronously whether any allowed model can satisfy each stated dimension, against a
   declared capability floor per model held by the gateway. If none can, reject the write
   with the dimension, the requested value, the best achievable value, and the provider
   achieving it.

5. **`unmet`.** A per-workload runtime state, entered after two consecutive full windows
   in which the target was missed and left after two consecutive full windows in which it
   was held. The symmetry is deliberate; do not "improve" it into a faster exit. The
   report carries dimension, target, observed value, window, and the per-provider
   rejection reason.

6. **Delivery surface.** Four HTTP surfaces:
   - `GET`/`PUT /v1/targets` — read and write the target document. Reads return a version;
     writes must supply the version they replace and get `409` on mismatch. A write that
     is infeasible by declaration returns `422` with the report from step 4.
   - `GET /v1/workloads/{name}/status` — the **authoritative** current state: per
     dimension, the target, the observed value or `insufficient_data`, the window, and the
     workload's `unmet` state with its report.
   - A notification on every entry into and exit from `unmet`, `POST`ed to a
     customer-configured URL with an HMAC signature header over the body computed with a
     per-customer secret, retried with backoff for approximately 15 minutes and then
     dropped. Dropping is safe and intended: the status resource is the record, the
     notification is not. Prove this deliberately — see the verification below.
   - `x-gateway-target-unmet: <dimension>` on responses served while the workload is
     `unmet`.

7. **Target store.** SQLite in WAL mode via `node:sqlite` (one file, path from the config
   file or `GATEWAY_STORE_PATH`), holding the target document, the persisted `unmet` state
   and its counters, and per-process window summaries. Per
   [#13](https://github.com/hoomji/henry-ai-router/issues/13) and ADR
   [`0002`](../../adr/0002-durable-target-store-with-cross-process-concurrency.md): the
   document write commits before the `200`; the `409` and the `unmet` transition both use
   the store's compare-and-set; the data path reads an in-memory copy refreshed by polling
   the version, never the store; and an unreadable store at boot yields passthrough
   forwarding with a failing management surface rather than a refusal to start. Rolling
   windows stay in memory — only the summary at each window close is written.

8. **Load script** under `gateway/src/dev/` sending a few hundred requests, printing the
   final split, the measured p95, and the current status resource.

Nothing here may touch the M1 forwarding path or leak server types into
`src/providers/` — the Decision Log's three constraints still hold, and the whole target
apparatus sits behind the `chooseProvider` seam and its own HTTP handlers.

Completion criterion: the traffic split changes when the target changes; an
arithmetically impossible target is rejected at write time with a named best-achievable
value; a target that stops holding raises `unmet` after two windows and clears after two;
a conflicting pair of ceilings yields the lower-priority one and fails the request instead
when that dimension is `hard`; a concurrent write with a stale version gets a `409`; and a
workload in `unmet` is still in `unmet` after the process is restarted.

Verification: run the load script twice with different targets and compare printed splits.
Then, each producing its named artifact in "Artifacts and Notes":

- `PUT` a target of `p95_ms: 1` and expect `422` naming the best achievable value.
- `PUT` twice with the same version and expect `409` on the second.
- Degrade both stub providers past the target, wait two windows, and expect the status
  resource to report `unmet`, a signed notification to arrive, and subsequent responses to
  carry `x-gateway-target-unmet`. Restore the stubs and expect the state to clear only
  after two held windows, not one.
- Drive a workload into `unmet`, restart the gateway process, and confirm the status
  resource still reports `unmet` with its binding reason, that no duplicate entry
  notification fires, and that the workload reports `insufficient_data` for its dimensions
  until the window refills. This is the criterion #13 exists to produce.
- Repeat the degradation with the notification endpoint refusing connections, and confirm
  the status resource still reports `unmet` — this is the guarantee that makes dropping
  notifications acceptable.
- Send a request with `x-gateway-workload` naming a second workload with a different
  target and confirm it routes differently from `default` in the same run.

Rollback and recovery: additive under `gateway/`; revert to recover. The HTTP surfaces are
new paths and do not modify M1's endpoint. Because this milestone publishes customer-facing
contracts, treat a revert after those contracts are exposed to any real customer as a
breaking change rather than a discard.

Escalate when: holding a feasible target requires oscillating the split more than 20%
between consecutive windows (record in Surprises & Discoveries and redesign the loop
before adding damping), or when the declared capability floor per model in step 4 turns
out not to be knowable for a real provider — that would undercut
`infeasible_by_declaration` and is a product question owned by the spec, not this plan.

Escalate when: results suggest the target-state interface itself is wrong (a product
question owned by the spec, not this plan).

## Plan of Work

M1 is the additive tracer: it creates the runtime under `gateway/`,
and updates the three documents that currently deny a runtime exists (`AGENTS.md`,
`ARCHITECTURE.md`, `docs/harness/manifest.yaml`). It proves the spec's fail-open boundary
first because every later behavior sits on top of it. M2 implements the first product
behavior in full — the target vocabulary specified in the product spec plus its
customer-facing HTTP surfaces — kept additive and behind the `chooseProvider` seam so it
changes routing policy without touching the forwarding path. Everything after M2 — the
connector, then reservation-aware routing (behavior 4), then strain-triggered interception
(behavior 2) — belongs to the successor plan named in the Decision Log; behaviors 3 and 5
are deferred on triggers stated in the product spec's *Behavior sequence and deferrals*
section.

## Concrete Steps

Planned commands, all from the repository root (replace with actually-run commands as
work proceeds):

    python scripts/setup.py
    npm --prefix gateway install
    npm --prefix gateway run build
    npm --prefix gateway test
    python scripts/harness-validate.py .
    python scripts/check.py

Actually run, 2026-08-15, all passing:

    npm --prefix gateway install
    npm --prefix gateway run build
    npm --prefix gateway test          # 132 tests, 35 suites, 0 fail
    npm --prefix gateway run load      # M2's evidence artifact; exits non-zero on a flat split
    python scripts/harness-validate.py .
    python scripts/check.py            # PASS: repository gate (3 of 3)

M1's start command and M2's load command are recorded in their milestones; the start, test,
and load commands also land in `AGENTS.md`'s command list and in
`docs/harness/manifest.yaml`.

## Validation and Acceptance

The plan is complete when a novice, following M1's start command from `AGENTS.md`, can
observe: (1) a proxied completion response, (2) the fail-open header under the forced
error flag, and (3) M2's load script demonstrating a target-driven traffic split, plus M2's
five named verification artifacts covering `infeasible_by_declaration`, the `409` on a
stale write, `unmet` entry and its two-window exit, `unmet` surviving an unreachable
notification endpoint, and per-workload routing. Automated proof: `python scripts/check.py`
passes, plus the gateway's own test command introduced in M1: `npm --prefix gateway test`.
This evidence maps directly to the spec's four behavior-1 acceptance criteria and the
fail-open boundary; the spec's remaining criteria stay open and unclaimed.

## Idempotence and Recovery

All milestones are additive. Document edits and new directories are recoverable via git
revert. Reinstalling dependencies, rebuilding, and restarting gateway or stub processes are
safe at any time. No destructive operations, migrations, or external state exist in this
plan.

## Artifacts and Notes

**M1 verification transcript — 2026-08-15, Node v24.18.0, npm 11.16.0.** Stub upstream on
8081; gateway on 8080; a second gateway on 8082 with `FORCE_ROUTER_ERROR=1`, so both paths
are observable without restarting anything.

    $ curl -s -D - -X POST http://localhost:8080/v1/chat/completions -d '{"model":"any","messages":[]}'
    HTTP/1.1 200 OK
    content-type: application/json
    x-stub-upstream: true

    {"id":"chatcmpl-stub","object":"chat.completion","model":"stub-model","choices":[...],
     "usage":{"prompt_tokens":0,"completion_tokens":4,"total_tokens":4}}

    $ curl -s -D - -X POST http://localhost:8082/v1/chat/completions -d '{"model":"any","messages":[]}'
    HTTP/1.1 200 OK
    content-type: application/json
    x-stub-upstream: true
    x-gateway-failopen: true

    {"id":"chatcmpl-stub", ... same canned completion ... }

The second response is the fail-open boundary: routing threw, the request still reached the
upstream, and the header says so on the response rather than only in a log.

`npm --prefix gateway test` — 9 tests, 9 pass: normal forwarding, fail-open under a thrown
routing seam, `502` on an unreachable upstream, `404` outside the one endpoint, the routing
seam's decision and its refusal to invent a fallback, and three configuration cases.

**M2 load-script artifact — 2026-08-15, Node v24.18.0.** `npm --prefix gateway run load`.
Two simulated providers, no provider credentials, no routing rule configured anywhere. The
script warms up until both providers have genuinely closed a measurement window, measures
200 requests, and exits non-zero unless the split moves *and moves in the right direction*.
Three consecutive runs passed with the same direction.

    DEMO window settings — NOT production defaults (300000ms / 200 req / floor 20):
    GATEWAY_WINDOW_MS             1000
    GATEWAY_WINDOW_MIN_REQUESTS   8
    GATEWAY_SAMPLE_FLOOR          5

    RUN A — workload "default" targets p95_ms (latency)
    warmup for "default": 80 requests until both providers were measured
    provider      requests    share    p95 ms
    sim-a              184    92.0%       188
    sim-b               16     8.0%       818

    RUN B — workload "default" targets cost_per_1k_tokens_usd (cost)
    provider      requests    share    p95 ms
    sim-a               85    42.5%       189
    sim-b              115    57.5%       826

    THE CLAIM — same providers, same traffic, different target
    run     default target                   sim-a share   sim-b share   blended $/1k
    A       p95_ms                                 92.0%          8.0%       $0.02776
    B       cost_per_1k_tokens_usd                 42.5%         57.5%       $0.01390

    blended cost per 1k tokens: run A $0.02776 -> run B $0.01390 (-49.9%)
    shift in sim-a's share between the runs: 49.5 percentage points

    PASS: under the latency target the fast provider holds the larger share and the
    blended cost is higher; under the cost target both move the other way.

The residual 8% on the slow provider under a latency target is not leakage: routing keeps
sampling a provider it has not measured recently, because a provider that is never chosen
can never be measured (see *Surprises & Discoveries*).

**M2's named verification artifacts.** All six of the milestone's verification steps are
executable checks in `gateway/test/targetRouting.test.ts`, one `describe` per step, run by
`npm --prefix gateway test`:

- `422` naming the best achievable value, the provider achieving it, and the floor's
  provenance and age — `PUT` of `p95_ms: 1` against a catalogue whose fastest allowed model
  floors at 120 ms. A companion check proves a target *inside* the floor's variance is
  accepted, which is the spec's "rejection is biased against itself" rule.
- `409` on the second of two writes at the same version, with the current version returned
  and the losing write provably not applied.
- `unmet` raised only on the second consecutive missed window and cleared only on the
  second consecutive held window, with the status resource carrying the dimension, the
  target, and the observed value.
- `unmet` surviving a process restart with its binding reason intact, reporting
  `insufficient_data` for its dimensions until the window refills, and firing no duplicate
  entry notification. This is the criterion [#13](https://github.com/hoomji/henry-ai-router/issues/13) exists to produce.
- `unmet` still reported by the status resource when the notification endpoint refuses
  connections and delivery is dropped — the guarantee that makes dropping acceptable.
- A second workload named by `x-gateway-workload` routing differently from `default` in the
  same run, off the same measurement snapshot.

**Test and gate output — 2026-08-15.** `npm --prefix gateway test`: 132 tests, 35 suites,
132 pass, 0 fail. `python scripts/check.py`: `PASS: repository gate (3 of 3)`. Note that the
repository gate covers setup, harness consistency, and Markdown links only — it does not run
the gateway's tests, so a passing gate is not by itself evidence that the runtime works.

## Interfaces and Dependencies

- `POST /v1/chat/completions` — the gateway's single inbound endpoint in this plan,
  chosen because it is the de facto industry shape for chat model calls.
- `chooseProvider(request: GatewayRequest, state: ProviderState): RoutingDecision` — the
  routing seam. M1 returns the sole upstream; M2 replaces the body with target-state logic.
  `RoutingDecision` carries the chosen provider **and** the binding reason (the bounding
  dimension and the per-candidate rejection reasons) per the Decision Log. Keeping the
  function free of input/output is what makes M2 additive and what keeps a future Rust or
  Go data plane possible.
- `PUT /v1/targets`, `GET /v1/targets`, `GET /v1/workloads/{name}/status` — M2's
  management surfaces, versioned with optimistic concurrency (`409` on stale version,
  `422` on a target infeasible by declaration).
- An outbound signed notification on `unmet` transitions — at-least-once, bounded retry,
  droppable because the status resource is the authoritative record.
- `x-gateway-workload` (inbound, names the workload) and `x-gateway-target-unmet`
  (outbound, names the bound dimension while unmet).
- Provider adapters under `gateway/src/providers/` — pure translation between the gateway's
  request/response shape and a specific upstream's dialect, with no server or framework
  types. This is the contract a reimplemented data plane would have to honor.
- Environment variables `UPSTREAM_BASE_URL` and `FORCE_ROUTER_ERROR` — M1's only
  configuration surface.
- Runtime: Node.js 24 or newer, TypeScript compiled with `tsc`. Node standard library
  (`node:http`, global `fetch`) preferred; any third-party runtime dependency must be
  recorded in the Decision Log with rationale before being added. The repository's Python
  harness scripts are unaffected and remain the validation and gate entrypoints.

## Revision Note

2026-08-15 — M2 implemented and verified; the plan's checklist, artifacts, and retrospective
now state the delivered state rather than the intended one. Five Decision Log entries were
added for choices the implementation forced: the objective need not be a stated ceiling, an
unmeasured provider is explored ahead of a measured one, `targets/service.ts` exists outside
the design doc's proposed layout, simulated capability floors do not decay, and the data path
and the `unmet` machine read the store over different lookbacks. Four entries were added to
*Surprises & Discoveries*, the most consequential being the cold-start feedback loop that
made target-state routing inert until the exploration rule was inverted. The retrospective
states plainly what this plan does not entitle anyone to claim — behavior 1 is still not
shippable without the connector, and every result here is against simulated providers.

2026-08-15 — Recorded the behavior sequence resolved by grilling ticket
[#8](https://github.com/hoomji/henry-ai-router/issues/8). No milestone work changed: M1 and
M2 are relabeled, not reworked. The change is what they are understood to deliver — M2 is
behavior 1's decision engine rather than behavior 1 as a customer receives it, and M1's
in-path server is behavior 2's future interception path. Added the two Decision Log entries
that say so, an orientation paragraph explaining the out-of-path architecture an implementer
would otherwise not know about, and a pointer to the successor plan that carries the
connector and behavior 4. Written because an implementer finishing M2 today would reasonably
have concluded behavior 1 was shippable, and it is not until the connector exists.

2026-08-15 — Rewrote M2 from a narrow prototype (`{p95_ms, cost_per_1k}` in a config file)
to the spec's full target vocabulary plus its four customer-facing surfaces, dropped its
*Prototyping* label, and changed `chooseProvider`'s return type to carry a binding reason.
Driven by grilling ticket [#6](https://github.com/hoomji/henry-ai-router/issues/6), which
specified behavior 1 in full; the repository owner chose to build all of it in M2 rather
than stage the HTTP surfaces into a later milestone. M1 is unchanged.

2026-08-14 — Created this plan to carry the provider-risk-management-gateway product
specification from a documentation-only repository to a first runnable, fail-open tracer
and a target-state-routing prototype. IDEA.md, the spec's source material, is being
deleted in the same change; its content survives inside the spec.

2026-08-14 — Removed the former M1 ("Record the implementation-location ADR") and
renumbered the remaining milestones, because the repository owner confirmed that the
implementation lives in this repository; the question that milestone existed to answer is
settled, so gating all coding behind it would have been a milestone that produces no
working behavior. The decision itself is preserved in the Decision Log, and the ADR that
`ARCHITECTURE.md` requires is now written as part of the tracer milestone's documentation
work rather than as a separate approval gate. In the same revision, recorded the language
choice — TypeScript on Node, with the proxy data path deliberately kept thin so it can move
to Rust or Go later — and pushed that choice into the plan's structure (separate provider
adapters, an input/output-free `chooseProvider`), so that the future option stays open
rather than being merely asserted.
