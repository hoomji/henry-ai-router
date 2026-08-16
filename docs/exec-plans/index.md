# Execution plans

Lifecycle index for repository ExecPlans. Write plans with `harness-exec-plan` following
the instructions in [`PLAN.md`](../../PLAN.md). Every plan file appears in exactly one
section below and lives in exactly one directory: `active/` or `completed/`.

## Active

| Plan | Goal | Current milestone | Owner | Updated |
|---|---|---|---|---|
| _None._ | | | | |

## Completed

| Plan | Outcome | Evidence | Completed |
|---|---|---|---|
| [completed/2026-08-14-provider-risk-gateway-tracer.md](completed/2026-08-14-provider-risk-gateway-tracer.md) | A runnable fail-open gateway tracer (M1) and behavior 1's decision engine with its customer-facing HTTP surfaces (M2), against simulated providers | `npm --prefix gateway test` 132 pass; `npm --prefix gateway run load` shifts the split 49.5 points between a latency and a cost target; six named verification artifacts in `gateway/test/targetRouting.test.ts`; `python scripts/check.py` 3 of 3 | 2026-08-15 |
| [completed/2026-08-15-connector-and-reservation-aware-routing.md](completed/2026-08-15-connector-and-reservation-aware-routing.md) | The customer-installed `connector/` package calling providers directly under gateway-pushed ranked lists (M1), then reservation-aware routing — behavior 4 (M2), against simulated providers | `npm --prefix gateway run e2e` 7 of 7 checks, including no chat-completion request in the gateway's access log, a target switch inside five seconds, streaming time-to-first-byte 1070 ms against a 3084 ms stream, and `unmet` reached on connector reports alone with 0 in-path requests; `npm --prefix gateway test` 203 pass; `npm --prefix connector test` 32 pass; `py scripts/check.py` 3 of 3 | 2026-08-15 |

## Entry contract

- A new plan is created at `active/YYYY-MM-DD-short-slug.md` and added to the Active
  table in the same change.
- A plan moves to `completed/` only when its promised behavior and acceptance evidence
  exist; the same change moves its row to the Completed table.
- A plan is never listed in both tables and never exists in both directories.
- Debt discovered while executing a plan is recorded in
  [`tech-debt-tracker.md`](tech-debt-tracker.md), not left in the plan.
- A superseded plan stays in `completed/` with a link to its successor.
