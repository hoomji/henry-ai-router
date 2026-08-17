# Harness learning ledger

Record repeated friction only when it can improve a durable repository capability.

## Entries

Newest first.

### 2026-08-16 — documents kept their claims after the claims stopped being true

- Date: 2026-08-16
- Observed friction: a human reader found
  [`provider-risk-management-gateway.md`](../product-specs/provider-risk-management-gateway.md)
  still saying "this repository currently contains no implementation" two milestones after
  the gateway and the connector shipped. Auditing for the same class found a second live
  one immediately: [`gateway-design.md`](../design-docs/gateway-design.md) still said
  "there is no CI". Both files passed every gate check on the day they were false — the
  links resolved, the manifest was consistent, both suites were green.
- Frequency and impact: second occurrence of the *class* — a document whose text stops
  matching the repository — after the stale path inside a TypeScript comment recorded
  below, which deliberately deferred enforcement to a second occurrence. Impact is high for
  a repository that is mostly documentation: a false spec misroutes the next plan, and the
  delivery-status claim is the single sentence a reader trusts most.
- Missing harness plane: hygiene — nothing detected staleness at all, by age or by
  contradiction.
- Chosen durable layer: a script plus a routine, not a gate. `scripts/docs-audit.py` makes
  six mechanical passes (contradicted claims, index coverage, orphans, `Reviewed:` age,
  moved-ExecPlan pointers across Markdown/YAML/TypeScript/Python, placeholder markers) and
  [`docs-audit.md`](docs-audit.md) carries the four passes that need a reader. Advisory by
  default because "stale" is a judgement; `--strict` is the reviewer's switch. Deliberately
  *not* added to `scripts/check.py`: a gate that fails on a judgement call teaches people to
  route around the gate, which costs more than the drift.
- Change or decision not to encode: both false claims corrected; the spec's delivery
  evidence now names its artifacts and states what they do not prove. The pointers pass
  discharges the deferral recorded in the stale-path entry below, one language-agnostic
  regex rather than the comment-aware parser that entry judged too expensive.
- Owner: henry.tran@uniblock.dev
- Closure evidence: `python scripts/docs-audit.py --strict` exits 0 across 33 files. Proven
  negatively: appending "This repository currently contains no implementation." to
  [`tracer-workflow.md`](tracer-workflow.md) made it report that line and fail. It found the
  `gateway-design.md` CI claim on its first real run, which a human sweep had missed.
- Review date: 2026-11-16

### 2026-08-16 — CI was declared as capability before it had ever run

- Date: 2026-08-16
- Observed friction: `.github/workflows/gate.yml` was added and three planes' evidence began
  to lean on it while it had never executed once. The manifest was honest about this —
  `executable`, with the reason written out — but the pull to record a workflow's *existence*
  as a working capability is exactly how a manifest turns from evidence into aspiration.
- Frequency and impact: first occurrence in this repository, and the class is the one the
  manifest exists to prevent. Low impact here precisely because it was declared honestly.
- Missing harness plane: execution — no proof the commands worked off the machine that wrote
  them.
- Chosen durable layer: none new. The durable answer was to *run it* and then re-verify,
  which is the rule the manifest already encodes: `verified` requires an observation, not an
  artifact.
- Change or decision not to encode: `continuous_integration` moved `executable` → `verified`
  only after PR #15 showed both jobs green on a runner. Deliberately not encoded: a check that
  a workflow file has a recorded run. The manifest's status vocabulary already carries that
  distinction, and a script re-deriving it from the GitHub API would need a network call
  inside a gate that is offline by design.
- Owner: henry.tran@uniblock.dev
- Closure evidence: PR #15 — `gate` green in 21s, `end-to-end` green in 3m57s with 7/7 checks.
  Execution moved 3→4 on that evidence, and Policy deliberately did not: branch protection is
  unavailable on this repository's plan, so a red run still does not block a merge.
- Review date: 2026-11-16

### 2026-08-16 — the control plane's decision was only observable by standing up a server

- Date: 2026-08-16
- Observed friction: the gateway's entire product is a decision — which provider a workload's
  traffic goes to, and whether the connector adopted that decision — and the only way to see
  it was to start a gateway, mint a connector token, and read
  `GET /v1/workloads/{name}/status` per workload. After a failing `run e2e` or `run load`,
  the store holding the answer was a temp file nobody could read without writing a script.
- Frequency and impact: every runtime investigation so far. High impact on autonomy: an agent
  could tell that routing was wrong but not *what the gateway believed*, which is the
  difference between a diagnosis and a bisect.
- Missing harness plane: isolation (no task-local telemetry an agent can query for its own
  run); it was the baseline quality report's third recommendation.
- Chosen durable layer: tooling, with tests.
- Change or decision not to encode: `npm --prefix gateway run inspect`
  ([`gateway/src/dev/inspect.ts`](../../gateway/src/dev/inspect.ts)) — read-only, needs no
  running process, prints target and reservation versions, reservation liveness, the merged
  measurement window per provider, connector ack state with a `STALE` marker, reported token
  counts and the ranked list. Two constraints were deliberate: it reads through `TargetStore`
  rather than `node:sqlite`, so the design doc's one-module-knows-the-schema rule still holds;
  and its ranked order comes from `computeRankedList`, the same function the control plane
  pushes from, because a debugging view with its own ordering would be a second router and the
  one nobody tests. Connector tokens are printed truncated.
- Owner: henry.tran@uniblock.dev
- Closure evidence: five tests in
  [`gateway/test/inspect.test.ts`](../../gateway/test/inspect.test.ts) covering ranked order
  against a measured window, the stale/acked directive distinction, unmet and reservation
  liveness, token redaction, and the no-document case; `py scripts/check.py` reports
  `PASS: repository gate (5 of 5)` with 208 gateway tests.
- Review date: 2026-11-16

### 2026-08-16 — the tracer workflow described a repository that no longer existed

- Date: 2026-08-16
- Observed friction: [`tracer-workflow.md`](tracer-workflow.md) named a product-spec edit as
  the representative workflow and stated "Runtime evidence: not applicable; this repository
  has no runtime" — two milestones and two runtimes out of date. The harness was therefore
  being measured against its easiest workflow, and an agent following the tracer for a
  gateway change would find no boundary, no escalation rule, and no runtime evidence contract.
- Frequency and impact: structural, and it silently capped autonomy — every runtime workflow
  sat at R0 partly because no tracer described one.
- Missing harness plane: intent, and governance downstream of it.
- Chosen durable layer: documentation, as the tracer is itself a harness artifact.
- Change or decision not to encode: the tracer is now the runtime change, with the design
  doc's dependency rules, the accepted ADRs and the connector wire contracts named as
  stop-and-escalate conditions, and a runtime evidence ladder from `run inspect` through
  `run load` to `--e2e`. The documentation change is kept as the reduced-scope variant rather
  than deleted; it is still the right first workflow to hold an agent to. Not encoded: nothing
  mechanically detects a tracer that has gone stale. The honest trigger is the quality report,
  which is where this was caught.
- Owner: henry.tran@uniblock.dev
- Closure evidence: `py scripts/check.py` passes; the tracer's Evidence section now names
  commands that exist and were run today.
- Review date: 2026-11-16

### 2026-08-16 — the declared test command ran no tests

- Date: 2026-08-16
- Observed friction: `commands.test` in the manifest named `python scripts/check.py`, which
  ran setup, the harness contract check and a Markdown link check — and no test. 203 gateway
  tests, 32 connector tests and a seven-check end-to-end run existed and passed, but an agent
  following the declared command learned nothing about any of them, and a change could break
  all 235 while the gate stayed green.
- Frequency and impact: structural rather than repeated — it held for every change across
  both delivered milestones. Impact is high: it made the strongest evidence in the repository
  invisible to the one command agents are told to run.
- Missing harness plane: policy (feedback existed; nothing gated on it).
- Chosen durable layer: script, plus CI.
- Change or decision not to encode: `scripts/check.py` now runs both runtime suites — each
  builds first, so the gate typechecks both runtimes too — and takes `--e2e` for the
  end-to-end run, which stays out of the default gate because it binds ports and starts
  processes. [`.github/workflows/gate.yml`](../../.github/workflows/gate.yml) runs the same
  script on push and pull request.
- Owner: henry.tran@uniblock.dev
- Closure evidence: `python scripts/check.py` reports `PASS: repository gate (5 of 5)` and
  `--e2e` reports 6 of 6 with 7/7 checks. Proven negatively: a deliberately failing test in
  `gateway/test/` made the gate report `FAIL: repository gate failed (1 of 5)`.
- Review date: 2026-11-16

### 2026-08-16 — a stale documentation path hid inside a TypeScript comment

- Date: 2026-08-16
- Observed friction: `gateway/src/dev/e2e.ts` pointed at
  `docs/exec-plans/active/2026-08-15-connector-and-reservation-aware-routing.md` after that
  plan moved to `completed/`. The gate's link checker reads Markdown only, so a path that
  had stopped resolving sat in the code for a milestone without being caught.
- Frequency and impact: first occurrence, low impact on its own — but the class is
  unbounded, because every source comment that cites a document can rot the same way, and
  the repository deliberately carries a lot of rationale in comments.
- Missing harness plane: hygiene.
- Chosen durable layer: for now, the fix only. Decision not to encode yet: extending the
  link checker to source comments needs a comment-aware parser for two languages to avoid
  false positives on strings and URLs, which is more machinery than one occurrence justifies.
  Encode it on the second occurrence.
- Change or decision not to encode: path corrected in `gateway/src/dev/e2e.ts`; enforcement
  deferred with the trigger above.
- Owner: henry.tran@uniblock.dev
- Closure evidence: `python scripts/check.py` passes; the cited file exists at the corrected
  path.
- Review date: 2026-11-16

### 2026-08-16 — merged agent worktrees were never swept

- Date: 2026-08-16
- Observed friction: two worktrees under `.claude/worktrees/` survived their merges, still
  holding pre-deletion content including the removed `IDEA.md`. A search across the working
  directory returned four copies of several harness files, three of them stale.
- Frequency and impact: two of two research worktrees were left behind, so the rate is
  100%. Impact is on agent search: stale duplicates of `AGENTS.md` and the manifest are
  exactly the files an agent grep-reads first.
- Missing harness plane: hygiene (isolation worked; its cleanup did not).
- Chosen durable layer: manual sweep now, no automation.
- Change or decision not to encode: both worktrees removed with `git worktree remove` after
  confirming each was clean and its branch merged into `master`. The branches were kept —
  they are cheap and they are the recovery path. Not automated: worktree creation is driven
  by the agent harness rather than this repository, so a cleanup script here would be
  guessing at another tool's lifecycle.
- Owner: henry.tran@uniblock.dev
- Closure evidence: `git worktree list` shows only the primary checkout and one unrelated
  external worktree.
- Review date: 2026-11-16

### 2026-08-15 — the Python interpreter name is not portable

- Date: 2026-08-15 (recorded 2026-08-16)
- Observed friction: `python` resolves on the machine where the tracer was built; on the
  Windows machine where the connector was built only the `py` launcher resolves, and both
  `python` and `python3` fail. Every documented command starts with an interpreter name, so
  the first command an agent runs on a new machine can fail for a reason unrelated to its
  task.
- Frequency and impact: twice, on two of two machines used. Impact is a false failure at the
  very first step, which is the worst place for one.
- Missing harness plane: execution.
- Chosen durable layer: `AGENTS.md` guidance; enforcement deliberately declined.
- Change or decision not to encode: `AGENTS.md` states the substitution and that the scripts
  are interpreter-agnostic above Python 3.10. Not encoded as a wrapper script, because a
  shell wrapper would need its own per-platform variants and would move the same problem one
  level down. Revisit if a third interpreter name appears or if a contributor hits it again
  despite the note.
- Owner: henry.tran@uniblock.dev
- Closure evidence: `AGENTS.md` "Common commands"; `py scripts/check.py` passes on the
  Windows machine.
- Review date: 2026-11-16

## Entry template

- Date:
- Observed friction:
- Frequency and impact:
- Missing harness plane:
- Chosen durable layer:
- Change or decision not to encode:
- Owner:
- Closure evidence:
- Review date:
