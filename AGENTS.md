# Agent guidance

This repository is a product-exploration repository for an AI router/gateway. It
currently contains documentation only: there is no application code, no service, and
nothing to deploy. Treat that as the current state, not as a gap to fill silently.

## Repository map

- Architecture and boundaries: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Decisions: [`docs/adr/`](docs/adr/), numbered `NNNN-short-slug.md`
- Domain language: [`CONTEXT.md`](CONTEXT.md) — glossary only, no behavior or decisions
- Harness capability state: [`docs/harness/manifest.yaml`](docs/harness/manifest.yaml)
- Representative workflow: [`docs/harness/tracer-workflow.md`](docs/harness/tracer-workflow.md)
- Repeated-friction ledger: [`docs/harness/learning-ledger.md`](docs/harness/learning-ledger.md)

## Knowledge store

Start here, then follow the index that owns the question. Each store's index states its
own entry contract; nothing in these directories is authoritative unless its index lists
it.

- Required product behavior: [`docs/product-specs/index.md`](docs/product-specs/index.md)
- Design documentation and verification status: [`docs/design-docs/index.md`](docs/design-docs/index.md)
- Agent-first operating principles: [`docs/design-docs/core-beliefs.md`](docs/design-docs/core-beliefs.md)
- Active and completed execution plans: [`docs/exec-plans/index.md`](docs/exec-plans/index.md)
- Accepted technical debt: [`docs/exec-plans/tech-debt-tracker.md`](docs/exec-plans/tech-debt-tracker.md)
- ExecPlan authoring instructions: [`PLAN.md`](PLAN.md)
- External reference material: [`docs/references/index.md`](docs/references/index.md)
- Generated documentation, never hand-edited: [`docs/generated/index.md`](docs/generated/index.md)

## Common commands

Run these from the repository root. `python` is the interpreter name that resolves on the
maintainer's machine; `python3` does not.

- Setup: `python scripts/setup.py`
- Start: `unknown` — there is no startable runtime in this repository
- Focused check: `python scripts/harness-validate.py .`
- Full verification: `python scripts/check.py`
- Harness validation: `python scripts/harness-validate.py .`

## Working agreement

Follow the linked sources of truth. Keep changes within the requested scope. Verify the
acceptance criteria with the narrowest relevant checks, then run the repository gate when
the environment supports it. Follow the representative workflow's evidence contract.
Report skipped checks and residual risk.
