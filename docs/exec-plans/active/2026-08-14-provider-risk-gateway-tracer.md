# Stand up the provider-risk gateway from spec to first working tracer

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` current as work proceeds. Follow the repository's ExecPlan guidance at `PLAN.md` (repository root).

## Purpose / Big Picture

Today this repository contains only documentation: a product specification at
`docs/product-specs/provider-risk-management-gateway.md` describing an AI router/gateway
that sells provider risk management (target-state routing, incident-only interception,
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

- [ ] Scaffold the runnable gateway with a fail-open pass-through proxy (M1).
- [ ] Implement target-state routing against simulated providers, decision surface and
      HTTP surfaces both (M2).

Add a timestamped entry at every stopping point. This checklist must state the actual
state of the work, not the originally intended sequence.

## Surprises & Discoveries

None yet.

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

- Decision: `chooseProvider` returns a binding reason alongside the chosen provider.
  Rationale: The spec requires both infeasibility reports to name why each candidate
  provider was rejected. A reason reconstructed from logs after the fact is not
  trustworthy, so the requirement is a constraint on the routing seam's return type rather
  than a logging concern. See `docs/adr/0001-declaration-time-vs-observed-infeasibility.md`.
  This changes the signature recorded under "Interfaces and Dependencies" below.
  Date/Author: 2026-08-15 / Claude (planning), per #6

## Outcomes & Retrospective

Not started.

## Context and Orientation

This repository (`henry-ai-router`) is documentation-only today. The authoritative files
are:

- `AGENTS.md` — repository guidance and command list. Commands: setup
  `python scripts/setup.py`; harness validation `python scripts/harness-validate.py .`;
  full gate `python scripts/check.py`. The interpreter is `python` (not `python3`) on the
  maintainer's machine. These Python scripts are the *harness* — they validate
  documentation — and are unrelated to the gateway's own language; they stay in Python.
- `ARCHITECTURE.md` — states that this repository owns product *thinking* and that adding
  an implementation is an architectural change requiring an ADR at
  `docs/adr/NNNN-short-slug.md`. No ADRs exist yet;
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
changes routing policy without touching the forwarding path. Pricing behaviors (2 and 4), cross-customer signals (3), and
prompt translation (5) are out of this plan's scope until their open product decisions in
the spec are resolved.

## Concrete Steps

Planned commands, all from the repository root (replace with actually-run commands as
work proceeds):

    python scripts/setup.py
    npm --prefix gateway install
    npm --prefix gateway run build
    npm --prefix gateway test
    python scripts/harness-validate.py .
    python scripts/check.py

M1's start command and M2's load command are recorded in their milestones once the
implementation exists; the start and test commands must also land in `AGENTS.md`'s command
list and in `docs/harness/manifest.yaml`.

## Validation and Acceptance

The plan is complete when a novice, following M1's start command from `AGENTS.md`, can
observe: (1) a proxied completion response, (2) the fail-open header under the forced
error flag, and (3) M2's load script demonstrating a target-driven traffic split, plus M2's
five named verification artifacts covering `infeasible_by_declaration`, the `409` on a
stale write, `unmet` entry and its two-window exit, `unmet` surviving an unreachable
notification endpoint, and per-workload routing. Automated proof: `python scripts/check.py`
passes, plus the gateway's own test command introduced in M1 (recorded here when created).
This evidence maps directly to the spec's four behavior-1 acceptance criteria and the
fail-open boundary; the spec's remaining criteria stay open and unclaimed.

## Idempotence and Recovery

All milestones are additive. Document edits and new directories are recoverable via git
revert. Reinstalling dependencies, rebuilding, and restarting gateway or stub processes are
safe at any time. No destructive operations, migrations, or external state exist in this
plan.

## Artifacts and Notes

None yet; add M1's curl transcripts and M2's load-script output here as they are produced.

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
