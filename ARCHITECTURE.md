# Architecture map

## System boundary

This repository owns the *thinking* about an AI router/gateway product: candidate
product directions, the reasoning behind them, and the documentation harness that keeps
that reasoning reviewable.

It does not own an implementation. There is no service, library, package manifest, build,
deployment target, or runtime dependency in this repository today. A future
implementation would be a separate component, and adding one here is an architectural
change that belongs in an ADR rather than in a routine edit.

## Components and dependency direction

| Component | Path | Role |
|---|---|---|
| Knowledge store | `docs/` | Product specs, design docs, execution plans, references, generated output |
| Harness state | `docs/harness/` | Manifest, tracer workflow, learning ledger |
| Repository scripts | `scripts/` | The deterministic setup, validation, and gate entrypoints |

Dependency direction is one-way: `scripts/` reads `docs/` to validate it, and never the
reverse. Documentation never depends on script internals; it depends only on the command
names advertised in [`AGENTS.md`](AGENTS.md).

## External systems and runtime state

None. There are no services, data stores, queues, credentials, or observable runtime
surfaces. Every check runs offline against the working tree, which is why the harness
manifest declares `startable_runtime` as missing rather than guessing a start command.

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

## Domain language

[`CONTEXT.md`](CONTEXT.md) is the glossary for this product's domain. It is a glossary
only: required behavior belongs in `docs/product-specs/`, decisions in `docs/adr/`.

## Design documentation

[`docs/design-docs/index.md`](docs/design-docs/index.md) catalogues design documentation
and its verification status. Design docs explain evolving system or feature designs;
ADRs remain the decision history.
