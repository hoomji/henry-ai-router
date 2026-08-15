# Architecture map

## System boundary

This repository owns the *thinking* about an AI router/gateway product — candidate product
directions, the reasoning behind them, and the documentation harness that keeps that
reasoning reviewable — and, since M1 of the tracer ExecPlan, the implementation that
thinking is for.

That implementation is the gateway under `gateway/`: an HTTP service in TypeScript on
Node.js 24, with zero runtime dependencies, recorded in
[`0008`](docs/adr/0008-implementation-lives-in-this-repository.md). It is not deployed
anywhere and has no deployment target. What it currently does is forward a chat completion
to one configured upstream and keep doing so when its own routing logic fails; what it is
*for* is stated in the tracer ExecPlan, not inferable from the code.

## Components and dependency direction

| Component | Path | Role |
|---|---|---|
| Knowledge store | `docs/` | Product specs, design docs, execution plans, references, generated output |
| Harness state | `docs/harness/` | Manifest, tracer workflow, learning ledger |
| Repository scripts | `scripts/` | The deterministic setup, validation, and gate entrypoints |
| Gateway runtime | `gateway/` | The HTTP service: forwarding path, routing seam, provider adapters |

Dependency direction is one-way: `scripts/` reads `docs/` to validate it, and never the
reverse. Documentation never depends on script internals; it depends only on the command
names advertised in [`AGENTS.md`](AGENTS.md). `gateway/` is a fourth component rather than
an exception to that rule — it reads neither `docs/` nor `scripts/`, and neither reads it.

Inside `gateway/`, one further rule carries architectural weight and is the first thing to
check in any gateway change: nothing under `src/routing/`, `src/targets/`, or
`src/providers/` may import `src/server.ts` or any `node:http` type. Provider adapters
describe an upstream call and never perform it, and the routing seam is a pure function of
a state snapshot. That is what keeps the forwarding path replaceable in another language
without rewriting routing policy, and what lets the same routing function later produce a
ranked list for the *connector* rather than a per-request choice. The layout and the
adapter contract are in
[`docs/design-docs/gateway-design.md`](docs/design-docs/gateway-design.md).

## External systems and runtime state

The gateway calls one upstream, named by `UPSTREAM_BASE_URL`, and holds no credentials,
data store, or queue. Its only other configuration is `PORT` and `FORCE_ROUTER_ERROR`, a
test flag that makes the routing seam throw so the fail-open path is observable. A stub
upstream under `gateway/src/dev/` serves canned completions, so every check still runs
offline against the working tree with no provider account involved.

The harness manifest now declares `startable_runtime` and `automated_tests` as verified,
with the start, stub, and test commands as evidence. `continuous_integration` remains
missing — nothing runs these commands except a person.

## Decisions

ADRs live at `docs/adr/NNNN-short-slug.md`.

- [`0001`](docs/adr/0001-declaration-time-vs-observed-infeasibility.md) — declaration-time
  and observed infeasibility are two states, not one.
- [`0002`](docs/adr/0002-durable-target-store-with-cross-process-concurrency.md) — the
  target document lives in a durable store designed for concurrent writers.
- [`0003`](docs/adr/0003-provenance-tiered-capability-catalogue.md) — capability floors
  carry a provenance tier and an age, and the feasibility check abstains rather than
  rejecting on an expired floor. Amends `0001` in part.
- [`0004`](docs/adr/0004-incidents-included-not-surcharged.md) — incidents are included in
  the subscription, not surcharged, because the gateway declares the incident window and
  must not be paid by its own declarations.
- [`0005`](docs/adr/0005-strain-evidence-detection-internal.md) — strain detection reads
  the internal aggregate while disclosure stays banded, which splits *provider strain*
  from the *interception window* and retires the word *incident* used by `0004`.
- [`0006`](docs/adr/0006-routing-authority-stays-gateway-side.md) — routing policy stays in
  the gateway and the *connector* obeys a *ranked list*, which keeps one implementation of
  the routing decision and one authoritative *binding reason*.
- [`0007`](docs/adr/0007-strain-contribution-is-a-condition-of-service.md) — contributing
  strain evidence is a condition of service, bounded to facts the provider side of the
  connection already observed.
- [`0008`](docs/adr/0008-implementation-lives-in-this-repository.md) — the gateway
  implementation lives in this repository under `gateway/`, which retires this document's
  former "no implementation" boundary.

## Domain language

[`CONTEXT.md`](CONTEXT.md) is the glossary for this product's domain. It is a glossary
only: required behavior belongs in `docs/product-specs/`, decisions in `docs/adr/`.

## Design documentation

[`docs/design-docs/index.md`](docs/design-docs/index.md) catalogues design documentation
and its verification status. Design docs explain evolving system or feature designs;
ADRs remain the decision history.
