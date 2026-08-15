# Agent guidance

This repository is a product-exploration repository for an AI router/gateway. Most of it
is documentation — the product thinking, its decisions, and the harness that keeps them
reviewable. It also contains one runtime: the gateway tracer under [`gateway/`](gateway/),
the M1 milestone of the tracer ExecPlan. Nothing is deployed anywhere.

The runtime is deliberately small. Read
[`docs/exec-plans/active/2026-08-14-provider-risk-gateway-tracer.md`](docs/exec-plans/active/2026-08-14-provider-risk-gateway-tracer.md)
before extending it: what `gateway/` is *for* — and what M1 is not — is stated there, not
inferable from the code.

## Repository map

- Architecture and boundaries: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Gateway runtime: [`gateway/`](gateway/) — layout and seam rules in
  [`docs/design-docs/gateway-design.md`](docs/design-docs/gateway-design.md)
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
- Focused check: `python scripts/harness-validate.py .`
- Full verification: `python scripts/check.py`
- Harness validation: `python scripts/harness-validate.py .`

The gateway runtime has its own commands. `npm --prefix gateway install` is its setup, and
`build` must run before `start` or `stub` because the tracer runs compiled JavaScript.

- Install: `npm --prefix gateway install`
- Build: `npm --prefix gateway run build`
- Start: `npm --prefix gateway run start` — requires `UPSTREAM_BASE_URL`; `PORT` defaults
  to 8080, and `FORCE_ROUTER_ERROR=1` makes the routing seam throw so the fail-open path
  is observable
- Stub upstream: `npm --prefix gateway run stub` — a canned-completion provider on
  `STUB_PORT` (default 8081), so the tracer runs with no provider credentials
- Test: `npm --prefix gateway test`

## Working agreement

Follow the linked sources of truth. Keep changes within the requested scope. Verify the
acceptance criteria with the narrowest relevant checks, then run the repository gate when
the environment supports it. Follow the representative workflow's evidence contract.
Report skipped checks and residual risk.
