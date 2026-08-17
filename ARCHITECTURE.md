# Architecture map

## System boundary

This repository owns the *thinking* about an AI router/gateway product — candidate product
directions, the reasoning behind them, and the documentation harness that keeps that
reasoning reviewable — and, since M1 of the tracer ExecPlan, the implementation that
thinking is for.

That implementation is now **two** runtimes, both TypeScript on Node.js 24 with zero runtime
dependencies. Neither is deployed anywhere and neither has a deployment target. The choice
to put them here, and to write them in TypeScript, is recorded in the tracer ExecPlan's
Decision Log. What each is *for* is stated in its ExecPlan, not inferable from the code.

**In normal operation the gateway is not in the request path.** This is the single most
surprising thing about this architecture and the first thing to understand before changing
anything: the customer's application calls a provider *directly*, through the connector, and
the gateway never sees the request. The gateway influences routing by pushing ordered lists
of providers, not by carrying traffic. Its own forwarding data path is retained for the
strain-triggered interception windows of behavior 2 — which is not built — and not because
it serves traffic today.

- The **connector** under `connector/` is where provider calls happen. It is a small package
  the customer installs in their own application at the call site. It holds exactly one
  routing rule of its own — on a network error, a 429, or a 5xx, try the next provider in
  the list — plus a statically configured fallback provider used before any list has ever
  arrived, which is what makes it safe to install before the gateway is reachable. It relays
  streamed responses rather than buffering them, batches usage reports back to the gateway,
  and writes `x-gateway-target-unmet` onto the response the calling application receives —
  a header only it can write, because only it sees the response.
- The **gateway** under `gateway/` is a control plane. It holds the customer's target
  document behind `GET`/`PUT /v1/targets` and their reservation document behind
  `GET`/`PUT /v1/reservations`, checks a target's feasibility at declaration time, persists
  both documents and the `unmet` state machine to a SQLite store, reports the authoritative
  per-workload state at `GET /v1/workloads/{name}/status`, and pushes ranked provider lists
  to connectors over Server-Sent Events with a polling fallback. It also keeps a **data
  path** that forwards a chat completion to a provider chosen by the routing seam and falls
  back to the configured upstream when its own routing logic throws.

Two consequences of the split are load-bearing. First, a gateway outage does not stop
customer traffic — the connector keeps calling whichever provider was last pushed — so the
gateway is not a single point of failure, and a target change instead takes effect within
about five seconds rather than instantly. Second, and easier to break: because the gateway
is out of the path, **connector-reported usage is the only input the measurement windows
have.** Reports are folded into the windows at ingestion in `src/controlplane/api.ts`; a
change that stops that happening leaves every provider `insufficient_data` forever and makes
`unmet` unreachable, and will not fail any unit test. See the connector ExecPlan's
*Surprises & Discoveries*.

**Infrastructure cost and capacity sizing for this push model are not documented anywhere
in this repository.** There is no expected-connector-count projection, no per-connection
memory/CPU budget for the held-open SSE sockets, and no hosting cost estimate for the
gateway process. Before committing to a deployment target, size this from real connector
growth assumptions rather than assuming the push model is free — it is cheap, but "cheap"
has not been quantified.

The data path reads an in-memory copy of the document, refreshed by polling. So a store
outage or a broken management surface degrades only the control plane — writes fail and
status may go stale — while forwarding continues. A `200` on `PUT /v1/targets` means
*committed*, not *in force in every process*.

## Components and dependency direction

| Component | Path | Role |
|---|---|---|
| Knowledge store | `docs/` | Product specs, design docs, execution plans, references, generated output |
| Harness state | `docs/harness/` | Manifest, tracer workflow, learning ledger |
| Repository scripts | `scripts/` | The deterministic setup, validation, and gate entrypoints |
| Gateway runtime | `gateway/` | The control plane: ranked-list push, routing seam, provider adapters, target and reservation stores, management surfaces, plus a retained forwarding path |
| Connector runtime | `connector/` | The customer-installed component that calls providers directly under a pushed ranked list |

Dependency direction is one-way: `scripts/` reads `docs/` to validate it, and never the
reverse. Documentation never depends on script internals; it depends only on the command
names advertised in [`AGENTS.md`](AGENTS.md). `gateway/` and `connector/` are further
components rather than exceptions to that rule — neither reads `docs/` or `scripts/`, and
neither is read by them. The two runtimes are also kept apart from each other, deliberately:
they share no code and talk only over HTTP. The connector ships into someone else's
application and must stay small enough that installing it is not a decision, and merging the
packages would make it impossible to see when it is growing.

Inside `gateway/`, one further rule carries architectural weight and is the first thing to
check in any gateway change: nothing under `src/routing/`, `src/targets/`,
`src/reservations/`, or `src/providers/` may import `src/server.ts`, `src/management/`,
`src/controlplane/`, `node:http`, or any framework type. Provider adapters describe an upstream call and never perform it, and the
routing seam is a pure function of a state snapshot. That is what keeps the forwarding path
replaceable in another language without rewriting routing policy, and what lets the same
routing function later produce a ranked list for the *connector* rather than a per-request
choice.

The rule has exactly two deliberate concessions, both declared so a reviewer can tell a
concession from drift. `src/targets/store.ts` performs I/O against `node:sqlite`, and
`src/controlplane/api.ts` imports `node:http` because it is the connector-facing HTTP edge,
exactly as `src/management/api.ts` is the management edge. Each is confined to its one
module so the surrounding logic stays pure and a Rust or Go data plane replaces one file
rather than a package. Confinement is checkable — `store.ts` is the only file in `src/` that
names `node:sqlite`, and `node:http` appears only in `server.ts`, the two `api.ts` files,
and `src/dev/`. The pure parts of the control plane sit outside `api.ts` for that reason:
`controlplane/rankedList.ts` derives the ranked order by calling `chooseProvider` repeatedly
rather than through a second comparator, and `controlplane/usageOutcome.ts` maps a reported
call to an outcome. Both are unit-testable without a socket.

`src/management/` is a sibling of `src/server.ts`, not part of it. The management surfaces
are control-plane, serve no customer model traffic, and must be able to fail without
touching the data path; folding them into the server would make a control-plane failure
share a fate with forwarding, which is the fail-open boundary applied to our own code. The
same rule explains where `src/targets/service.ts` lives: it assembles the target apparatus
and is imported by both `server.ts` and `management/api.ts`, so it must sit somewhere both
may import — and since nothing under `targets/` may import `management/`, it sits under
`targets/`. It delivers `unmet` notifications through an injected callback rather than by
importing `management/notify.ts`, which would have been the first crack in the rule.

The layout and the adapter contract are in
[`docs/design-docs/gateway-design.md`](docs/design-docs/gateway-design.md), reconciled with
the current tree on 2026-08-15 including `controlplane/` and `reservations/`.

## External systems and runtime state

In normal operation the *connector* calls providers, using the customer's own provider
credential, which never reaches the gateway. The gateway retains its own upstreams —
the providers named by `GATEWAY_PROVIDERS`, defaulting to the single upstream at
`UPSTREAM_BASE_URL` — for the data path it keeps but does not normally use.

The store at `GATEWAY_STORE_PATH` (default `gateway-store.sqlite`) carries the target
document, the reservation document, per-process window summaries, the `unmet` state,
decision receipts, and three tables the connector work added: `connectors` (minted bearer
tokens against the customer they belong to), `connector_directive`, and `connector_usage`.
Every store query is scoped through a `forCustomer()` view; the hardcoded single customer
key is gone. Two credentials live in configuration and never in the store:
`GATEWAY_NOTIFY_SECRET`, which signs `unmet` notifications, and `GATEWAY_ADMIN_TOKEN`, which
guards the connector-minting endpoint and, when absent, makes that endpoint answer `404`
rather than standing unguarded. Neither is logged or returned by any endpoint. Every
variable beyond the original two is optional and defaults to prior behavior, so the
two-variable tracer setup still works; the full list for both runtimes is in
[`AGENTS.md`](AGENTS.md).

A stub upstream and a set of simulated providers under `gateway/src/dev/` serve canned and
parameterized completions, so every check still runs offline against the working tree with
no provider account involved. That is also the honest limit of the evidence: nothing here
has been exercised against a real provider, and no measured capability floor exists.

The harness manifest declares `startable_runtime`, `automated_tests`, `management_surface`,
`durable_state`, `target_routing_load_evidence`, `control_plane_push`, `connector_runtime`,
`reservation_aware_routing`, and `connector_e2e_evidence` as verified, with commands and
test files as evidence. `real_provider_verification` and `continuous_integration` are
missing: all proof is simulated, and nothing runs these commands except a person.

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

## Domain language

[`CONTEXT.md`](CONTEXT.md) is the glossary for this product's domain. It is a glossary
only: required behavior belongs in `docs/product-specs/`, decisions in `docs/adr/`.

## Design documentation

[`docs/design-docs/index.md`](docs/design-docs/index.md) catalogues design documentation
and its verification status. Design docs explain evolving system or feature designs;
ADRs remain the decision history.
