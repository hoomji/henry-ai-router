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
| Idea record | [`IDEA.md`](IDEA.md) | Candidate product directions and the meta-pattern across them |
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

No ADRs exist yet. When the first hard-to-reverse choice arises — most likely "does
implementation live in this repository or a separate one?" — record it at
`docs/adr/NNNN-short-slug.md`.

## Design documentation

[`docs/design-docs/index.md`](docs/design-docs/index.md) catalogues design documentation
and its verification status. Design docs explain evolving system or feature designs;
ADRs remain the decision history.
