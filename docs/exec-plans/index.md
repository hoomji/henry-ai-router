# Execution plans

Lifecycle index for repository ExecPlans. Write plans with `harness-exec-plan` following
the instructions in [`PLAN.md`](../../PLAN.md). Every plan file appears in exactly one
section below and lives in exactly one directory: `active/` or `completed/`.

## Active

| Plan | Goal | Current milestone | Owner | Updated |
|---|---|---|---|---|
| [active/2026-08-14-provider-risk-gateway-tracer.md](active/2026-08-14-provider-risk-gateway-tracer.md) | From spec to a runnable fail-open gateway tracer plus behavior 1's decision engine | M1 — fail-open gateway tracer (TypeScript on Node) | henry.tran@uniblock.dev | 2026-08-15 |
| [active/2026-08-15-connector-and-reservation-aware-routing.md](active/2026-08-15-connector-and-reservation-aware-routing.md) | The customer-installed connector, then reservation-aware routing (behavior 4) | M1 — connector (not started; blocked on the tracer plan) | henry.tran@uniblock.dev | 2026-08-15 |

## Completed

_No completed plans._

| Plan | Outcome | Evidence | Completed |
|---|---|---|---|

## Entry contract

- A new plan is created at `active/YYYY-MM-DD-short-slug.md` and added to the Active
  table in the same change.
- A plan moves to `completed/` only when its promised behavior and acceptance evidence
  exist; the same change moves its row to the Completed table.
- A plan is never listed in both tables and never exists in both directories.
- Debt discovered while executing a plan is recorded in
  [`tech-debt-tracker.md`](tech-debt-tracker.md), not left in the plan.
- A superseded plan stays in `completed/` with a link to its successor.
