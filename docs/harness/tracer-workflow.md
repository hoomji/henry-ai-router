# Representative workflow

Two workflows are described here, because this repository performs two kinds of change and
the harness has to carry the harder one. The **runtime change** below is the tracer: if an
agent can complete it end to end using only the repository, the harness is doing its job. The
**documentation change** after it is the reduced-scope variant, and it is what an agent should
be held to first.

## A. Runtime change (the tracer)

### Outcome

A scoped behavioral change to the gateway under [`gateway/`](../../gateway/) or the connector
under [`connector/`](../../connector/) — one seam, with its test — that leaves both runtimes
green and the product's central claim still demonstrable.

### Preconditions and boundary

- Required local state: Node 24 or newer, Python 3.10+, and both runtimes installed
  (`npm --prefix gateway install`, `npm --prefix connector install`).
- Credentials or services: none. Every check runs against simulated providers on localhost.
- Maximum risk class: R1 (workspace edits only). No push, no PR, no shared state, and no
  process left listening after the run.
- Stop and escalate when: the change would cross a boundary stated in
  [`docs/design-docs/gateway-design.md`](../design-docs/gateway-design.md) (a module under
  `routing/`, `targets/` or `providers/` reading the environment, a clock, or the store; a
  second module importing `node:sqlite`), contradict an accepted ADR under
  [`docs/adr/`](../adr/), change a wire contract a connector already depends on, or add a
  runtime dependency outside the Node standard library. Those are ADR-level decisions, not
  routine edits.

### Steps

1. Read [`AGENTS.md`](../../AGENTS.md), then the completed ExecPlan that owns the surface
   being changed — what each runtime is *for*, and what it deliberately is not, is stated
   there and is not inferable from the code.
2. Make the smallest in-scope edit, with the test that would have caught its absence.
3. Run the narrowest check first (`npm --prefix gateway test` or
   `npm --prefix connector test`), then the repository gate.
4. Prove the behavior at runtime, not only in a unit test — see *Evidence*.
5. Review the diff and residual risk; leave the change unstaged for the maintainer.

### Acceptance criteria

- The change is confined to one seam, and its test fails without it.
- `python scripts/check.py` exits 0: prerequisites, harness contract, links, and both runtime
  suites — each of which builds first, so this also typechecks both runtimes.
- Anything touching routing, measurement, the control plane or the connector is additionally
  proven by `python scripts/check.py --e2e` reporting 7/7 checks. Unit tests cannot see the
  class of defect that run exists to catch: with the gateway out of the request path,
  connector-reported usage is the *only* input the measurement windows have.
- No file outside the stated scope changed.

### Evidence

- Focused verification: `npm --prefix gateway test` / `npm --prefix connector test`.
- Repository gate: `python scripts/check.py` — expect `PASS: repository gate`.
- Runtime evidence, in increasing cost:
  - `npm --prefix gateway run inspect` — a read-only snapshot of what the control plane
    believes: target and reservation versions, reservation liveness, the merged measurement
    window per provider, whether the connector acknowledged the list version it was pushed,
    and the ranked order itself. This is the first thing to run when a behavior looks wrong,
    and it needs no running process.
  - `npm --prefix gateway run load` — the traffic split moves with the target.
  - `python scripts/check.py --e2e` — the seven checks, including the gateway staying out of
    the request path.
  - `npm --prefix gateway run gateway:logged` — the access log, when the claim to be shown is
    about which requests reached the gateway at all.
- Handoff: changed artifacts, command results, skipped checks, and residual risks.

## B. Documentation change (reduced scope)

### Outcome

Add or revise an AI-router product specification under
[`docs/product-specs/index.md`](../product-specs/index.md). (The former idea record `IDEA.md`
was promoted into
[`docs/product-specs/provider-risk-management-gateway.md`](../product-specs/provider-risk-management-gateway.md)
and deleted.)

### Preconditions and boundary

- Required local state: a clean or intentionally dirty working tree, and Python 3.10+.
- Credentials or services: none. Every step runs offline; no runtime is started.
- Maximum risk class: R1 (workspace edits only). No push, no PR, no shared state.
- Stop and escalate when: the change would add application code, choose an implementation
  language or framework, or contradict an accepted product specification.

### Steps

1. Read [`AGENTS.md`](../../AGENTS.md) to locate the authoritative file for the change.
2. Make the smallest in-scope edit: one idea, or one specification created from
   [`docs/product-specs/template.md`](../product-specs/template.md) and listed in its index in
   the same change.
3. Run the focused check, then the repository gate.
4. Review the diff and residual risk; leave the change unstaged for the maintainer.

### Acceptance criteria

- The new idea or specification exists in exactly one authoritative file, and any new store
  artifact is listed in its store index by the same change.
- `python scripts/check.py` exits 0, proving the harness contract holds and every
  repository-local Markdown link still resolves.
- No file outside the stated scope changed.

### Evidence

- Focused verification: `python scripts/harness-validate.py .` — expect
  `PASS: harness contract is internally consistent`.
- Repository gate: `python scripts/check.py` — expect `PASS: repository gate`.
- Runtime evidence: not applicable. A documentation change starts no process, and running the
  runtime suites anyway is what the gate already does.
- Handoff: changed artifacts, command results, skipped checks, and residual risks.
