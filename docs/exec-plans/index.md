# Execution plans

Lifecycle index for repository ExecPlans. Write plans with `harness-exec-plan` following
the instructions in [`PLAN.md`](../../PLAN.md). Every plan file appears in exactly one
section below and lives in exactly one directory: `active/` or `completed/`.

## Active

_No active plans._

| Plan | Goal | Current milestone | Owner | Updated |
|---|---|---|---|---|

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
