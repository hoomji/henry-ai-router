# Harness quality report

- Revision: working tree on `master`, based on `1f23c35`, with the harness investments of
  2026-08-16 applied and uncommitted
- Report date: 2026-08-16 (second reading of the same day; the baseline reading at
  `1f23c35` is preserved in the transitions table below)
- Prior baseline: the first reading, taken earlier today at `1f23c35` before any change.
  There is no earlier period, so no multi-report trend exists yet.
- Method: plane levels follow the harness contracts' nine planes and their level scale
  (`0 opaque` … `5 adaptive`), assigning the lowest fully evidenced level. Evidence is current — commands were
  executed at this revision on 2026-08-16 rather than quoted from the manifest.
- Tracer workflow: [`tracer-workflow.md`](tracer-workflow.md) — now a **runtime change** to
  the gateway or connector (max risk R1, offline), with the product-spec edit kept as the
  reduced-scope variant. The tracer was raised because a documentation-only tracer no longer
  represents what this repository does, and because the harness should be measured against
  its harder workflow. Its old claim that "this repository has no runtime" was two milestones
  out of date.
- Comparison limits: no prior report, no CI history, and no recorded human-intervention
  log, so first-pass success, regression counts, and intervention rates cannot be
  computed for this period. They are labelled `unavailable` below rather than estimated.

## Commands executed for this report

| Command | Result |
|---|---|
| `py scripts/check.py` | `PASS: repository gate (5 of 5)`, exit 0 — setup, harness contract, 31 Markdown files link-checked, both runtime suites |
| `py scripts/check.py` with a deliberately failing test added | `FAIL: repository gate failed (1 of 5)` — the gate is proven to fail, not only to pass |
| `py scripts/check.py --e2e` | `PASS: repository gate (6 of 6)`, 7/7 end-to-end checks |
| `npm --prefix gateway test` | 208 tests, 0 fail (203 at the baseline reading) |
| `npm --prefix connector test` | 32 tests, 11 suites, 0 fail |
| `npm --prefix gateway run e2e` | 7/7 checks passed, including check 7 reaching `unmet` on connector reports with 0 in-path requests |
| `npm --prefix gateway run inspect -- --store <seeded store>` | printed targets, the merged window, the redacted connector, a `STALE` directive and the ranked order; `--store ./nope.sqlite` exits 1 rather than creating an empty store |

The Markdown count fell from 63 to 31 because two merged agent worktrees, each carrying a
stale copy of the harness documents, were removed.

## Plane levels

| Plane | Level | Evidence | Why not higher |
|---|---|---|---|
| Intent | 3 verifiable | [`docs/product-specs/provider-risk-management-gateway.md`](../product-specs/provider-risk-management-gateway.md), 7 ADRs under [`docs/adr/`](../adr/), two completed ExecPlans whose acceptance criteria are proven by `npm --prefix gateway run e2e` and `run load` | Nothing mechanically requires a change to name the spec or criterion it serves |
| Knowledge | 4 enforced | [`AGENTS.md`](../../AGENTS.md), [`ARCHITECTURE.md`](../../ARCHITECTURE.md), [`CONTEXT.md`](../../CONTEXT.md), five store indexes; `scripts/harness-validate.py` fails on manifest/index inconsistency and `scripts/check.py` fails on any unresolvable repository-local link | Enforcement covers structure and links, not whether prose still matches code; no drift detection over time |
| Execution | 3 verifiable | `scripts/setup.py`, `scripts/check.py`, gateway and connector `build`/`start`/`stub`/`test`/`e2e`/`load` — all re-run green today | CI now exists but has never run on a remote, so nothing yet proves the commands work off this machine; the Python interpreter name stays machine-dependent (`python` vs `py`) |
| Feedback | 4 enforced | 240 passing unit tests; `run e2e` distinguishes success from failure per check and exits non-zero; the gate executes both suites and was proven to fail on a failing test; `run load` asserts the traffic split moves with the target | Enforcement is only as reachable as the person running the gate until the CI workflow has an observed green run |
| Policy | 3 verifiable | `harness-validate`, the link check and both suites are pass/fail gates producing reproducible evidence; the gate's failure path is demonstrated, not assumed; the manifest now declares four policies, each naming the command that enforces it and the remediation for failing it | No lint or hook layer; no CI run observed, so nothing fails mechanically on push yet |
| Isolation | 3 verifiable | Every port and path is env-overridable (`PORT`, `STUB_PORT`, `GATEWAY_STORE_PATH`); `run e2e` starts and tears down its own processes; both stale agent worktrees removed after confirming each was clean and merged; `run inspect` gives an agent a read-only query over one run's own store — targets, measured windows, reservation liveness, connector ack state and the ranked order — so a runtime defect is diagnosable from the run's own artifacts | Worktree lifecycle is owned by the agent harness, not by this repository, so cleanliness is a habit rather than a mechanism; there is still no per-run log or trace an agent can filter to its own task |
| Lifecycle | 2 executable | Observable intake→spec→ADR→ExecPlan→branch→PR (#14)→merge path in history; ExecPlans carry acceptance evidence; CI now attaches the gate to pull requests | Review is human-only and unrecorded; no documented recovery or rollback path; no intake template or issue convention in-repo |
| Hygiene | 2 executable | The gate mechanically detects link and manifest/index drift on every run; [`learning-ledger.md`](learning-ledger.md) now carries four worked entries, each with a durable layer and closure evidence | The tech-debt tracker is still empty; nothing detects staleness by age; the sweep of merged worktrees was manual, and a stale doc path inside a source comment escaped every check |
| Governance | 1 documented | Risk classes named in the tracer workflow (max R1); `GATEWAY_ADMIN_TOKEN` absent means the mint surface returns 404 | No permissions configuration, approval gates, audit trail, or escalation path in the repository |

No plane is `unknown`. No level averaging is performed; there is no single readiness number.

## Level transitions since the baseline reading

Both readings are from 2026-08-16: the baseline at `1f23c35`, this one after the three
investments it recommended were implemented.

| Plane | Baseline | Now | Cause |
|---|---|---|---|
| Feedback | 3 | 4 | `scripts/check.py` executes both runtime suites, so a regression fails the declared gate. Demonstrated in both directions: green at 5 of 5, and `FAIL: repository gate failed (1 of 5)` with a deliberately failing test present. |
| Policy | 2 | 3 | The same change turned the gate from a structural check into one carrying reproducible test evidence, and the failure path was proven rather than assumed. Not 4: no observed CI run, no lint or hook layer. |
| Hygiene | 1 | 2 | The learning ledger went from template-only to four worked entries — including one that deliberately declines to encode, with a named trigger — and both merged worktrees were swept. |
| Execution | 3 | 3 | CI was added but has never run, so the plane's evidence is unchanged. It moves when a green remote run exists. |
| Lifecycle | 2 | 2 | CI attaches the gate to pull requests, but review recording and a recovery path — the actual blockers — are untouched. |
| Isolation | 2 | 3 | `npm --prefix gateway run inspect` — a tested, read-only snapshot of one run's store, deriving its ranked order from `computeRankedList` so it cannot disagree with what the control plane pushed. This was the baseline reading's third recommendation. |
| Intent, Knowledge, Governance | 3, 4, 1 | unchanged | No change was made to these planes. |

## Operational signals

| Signal | Value | Basis |
|---|---|---|
| Cold-start time | unavailable — `scripts/setup.py` ran inside a warm gate run and did not report duration | would need a timed clean-clone run |
| Clean setup success | pass | `py scripts/check.py` step 1, exit 0 |
| Worktree success | pass | both stale worktrees swept after confirming each was clean and merged; none remain |
| Acceptance criteria with executable proof | 2 of 2 completed ExecPlans | `run e2e` (7 checks) and `run load` are the named evidence artifacts and both are commands |
| First-pass success | unavailable | no run log or CI history |
| Regressions this period | 0 observed | all suites and the e2e run green at `1f23c35` |
| Human interventions by plane | unavailable | not recorded anywhere in the repository |
| Time to reviewable evidence | ~4 min for the full set | four commands above, run sequentially today |
| Promoted corrections | 4 | learning ledger entries, each with a durable layer and closure evidence |
| Doc freshness | within policy | 90-day window, newest docs dated 2026-08-15 |
| Pre-review invariant catches | 4 classes | link resolution, manifest/index consistency, both runtime suites, and a typecheck of each runtime as a side effect of its `test` script building first |
| Background-task recovery | pass | e2e check 4 — killing the gateway leaves traffic untouched, reconnects back off, restart recovers |
| Rollback rate | unavailable | no deploys, no release path |

## Recommended next investments

The baseline reading's three recommendations are implemented; the ledger records each one.
The next three, ranked:

1. **Get one green CI run, then re-verify.** `.github/workflows/gate.yml` exists but has
   never executed. Until it does, three planes are resting on a workflow nobody has seen
   work, and `continuous_integration` is honestly `executable` rather than `verified`.
   Pushing the branch is the whole task; the value is that it converts CI from an assertion
   into evidence and unblocks Execution 3→4.
2. **Record review outcomes.** Lifecycle is held at 2 by review being human-only and
   unrecorded: there is no way to compute first-pass success, regressions caught in review,
   or human interventions by plane, which is why five operational signals below are
   `unavailable`. A convention as small as a review-evidence note per merged PR makes the
   next report measure trends instead of describing state.
3. **Make a change name the intent it serves.** Intent is held at 3 because nothing
   mechanically requires a change to cite the product spec, ADR or acceptance criterion it
   implements — the citations exist, but by habit. The cheapest version is a gate step that
   fails a change touching `gateway/src/` or `connector/src/` with no reference to a document
   under `docs/`; the expensive failure mode it prevents is the one this repository is most
   exposed to, where the rationale lives in prose the code has quietly drifted from.

The baseline reading's third recommendation — a task-local inspection path — is **delivered**:
`npm --prefix gateway run inspect` ([`gateway/src/dev/inspect.ts`](../../gateway/src/dev/inspect.ts),
[`gateway/test/inspect.test.ts`](../../gateway/test/inspect.test.ts)) reads one run's store and
reports what the control plane believes, including the ranked order derived from the same
function the control plane pushes from. That moved Isolation 2→3.

`real_provider_verification` remains `missing` by design: every check runs against
simulated providers. That is a product-evidence gap, not a harness gap, and it is
correctly declared in the manifest rather than papered over.

## Autonomy readiness

- The tracer is now the runtime change, and it carries the boundary that makes autonomy
  safe: the design doc's dependency rules, the accepted ADRs, and the wire contracts are
  named as stop-and-escalate conditions rather than left to judgement.
- The documentation-change variant (product-spec edit) remains the lowest-risk entry point,
  with executable proof and a clean R1 boundary.
- Runtime changes to the gateway and connector now have enough evidence for **isolated R1
  experimentation**: the declared gate executes 240 tests and typechecks both runtimes, and
  it has been shown to fail when a test fails. That was the blocker at the baseline reading
  and it is gone. `run inspect` closes the other half: an agent that breaks routing can now
  see *what* the control plane decided and whether the connector adopted it, from the run's
  own store, without a human reproducing the failure.
- Release and anything touching a remote remain **R0 inspect only**: there is no observed
  CI run, no recorded review outcome, and no rollback path.
