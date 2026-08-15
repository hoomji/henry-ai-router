# Stand up the provider-risk gateway from spec to first working tracer

This ExecPlan is a living document. Keep `Progress`, `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective` current as work proceeds. Follow the repository's ExecPlan guidance at `PLAN.md` (repository root).

## Purpose / Big Picture

Today this repository contains only documentation: a product specification at
`docs/product-specs/provider-risk-management-gateway.md` describing an AI router/gateway
that sells provider risk management (target-state routing, incident-only routing,
collective fatigue-aware routing, usage-decay pricing, semantic-fidelity prompt
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
- [ ] Prototype target-state routing against simulated providers (M2).

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
  it is no longer an open question gating implementation. `ARCHITECTURE.md` requires a
  hard-to-reverse choice like this to be written down as an Architecture Decision Record
  (a short file stating context, decision, and consequences), so M1 records it at
  `docs/adr/0001-implementation-location-and-language.md` as part of its documentation
  work rather than as a separate approval gate.
  Date/Author: 2026-08-14 / henry.tran@uniblock.dev (confirmed), recorded by Claude

- Decision: The gateway is written in TypeScript on Node.js (version 20 or newer), and is
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
  `docs/adr/NNNN-short-slug.md`. No ADRs exist yet; M1 writes the first one and updates
  this document's system boundary, which currently denies that any implementation exists.
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
`gateway`, `"type": "module"`, engines Node >= 20), a `tsconfig.json` targeting a modern
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

Documentation work in the same milestone: write `docs/adr/0001-implementation-location-and-language.md`
recording the two decisions already in this plan's Decision Log (implementation in this
repository under `gateway/`; TypeScript on Node with a Rust/Go data-plane split as the
named future path) with their context and consequences, and link it from
`ARCHITECTURE.md`'s Decisions section. Update `ARCHITECTURE.md`'s system boundary and
component table, which currently state that no implementation exists. Update `AGENTS.md`'s
command list with the build, start, and test commands, and update
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

Rollback and recovery: the milestone is additive (new directory, new ADR, doc edits);
revert the commit to recover. Steps are idempotent — reinstalling, rebuilding, and
restarting the processes are always safe.

Escalate when: the fail-open semantics conflict with a security requirement not yet
written down, or a runtime dependency beyond the Node standard library appears necessary
and the trade-off is not obvious.

### M2 — Prototyping: target-state routing against simulated providers

Goal (labeled Prototyping): demonstrate the spec's behavior 1 in miniature. Two stub
providers with different simulated latency and per-request cost; a target expressed as
`{"p95_ms": <int>, "cost_per_1k": <float>}` supplied via a config file; a routing loop
that measures observed latency and cost and shifts the traffic split toward the target
without any customer-written rule.

Work: extend `chooseProvider` to consult a rolling window of observed latencies and costs
per provider — passed in as part of the `ProviderState` snapshot, never read from
input/output inside the function — and pick the provider that keeps the projected p95 and
cost inside the target. When the target is infeasible (neither provider can satisfy it),
log and report infeasibility explicitly, matching the spec's boundary behavior. Drive it
with a load script under `gateway/src/dev/` that sends a few hundred requests and prints
the final split and measured p95.

Completion criterion: the load script's output shows the traffic split changing when the
target changes, and an infeasible target produces an explicit infeasibility report rather
than silent best-effort.

Verification: run the load script (path and command recorded here when written) twice with
different targets and compare printed splits; run once with an impossible target and
observe the infeasibility report.

Rollback and recovery: prototype code is additive under `gateway/`; discard by reverting if
the approach is not promoted. Promotion criterion: the routing loop holds a feasible target
across a run without oscillating more than 20% between consecutive windows; otherwise
record findings in Surprises & Discoveries and redesign.

Escalate when: results suggest the target-state interface itself is wrong (a product
question owned by the spec, not this plan).

## Plan of Work

M1 is the additive tracer: it creates the runtime under `gateway/`, records the first ADR,
and updates the three documents that currently deny a runtime exists (`AGENTS.md`,
`ARCHITECTURE.md`, `docs/harness/manifest.yaml`). It proves the spec's fail-open boundary
first because every later behavior sits on top of it. M2 is an explicitly labeled prototype
of the first product behavior, kept additive so it can be promoted or discarded on
evidence, and kept behind the `chooseProvider` seam so it changes routing policy without
touching the forwarding path. Pricing behaviors (2 and 4), cross-customer signals (3), and
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
error flag, and (3) M2's load script demonstrating a target-driven traffic split and an
explicit infeasibility report. Automated proof: `python scripts/check.py` passes, plus the
gateway's own test command introduced in M1 (recorded here when created). This evidence
maps directly to the spec's acceptance criteria for behavior 1 and the fail-open boundary;
the spec's remaining criteria stay open and unclaimed.

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
- `chooseProvider(request: GatewayRequest, state: ProviderState): Provider` — the routing
  seam; M1 returns the sole upstream, M2 replaces the body with target-state logic.
  Keeping this signature stable, and keeping the function free of input/output, is what
  makes M2 additive and what keeps a future Rust or Go data plane possible.
- Provider adapters under `gateway/src/providers/` — pure translation between the gateway's
  request/response shape and a specific upstream's dialect, with no server or framework
  types. This is the contract a reimplemented data plane would have to honor.
- Environment variables `UPSTREAM_BASE_URL` and `FORCE_ROUTER_ERROR` — M1's only
  configuration surface.
- Runtime: Node.js 20 or newer, TypeScript compiled with `tsc`. Node standard library
  (`node:http`, global `fetch`) preferred; any third-party runtime dependency must be
  recorded in the Decision Log with rationale before being added. The repository's Python
  harness scripts are unaffected and remain the validation and gate entrypoints.

## Revision Note

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
