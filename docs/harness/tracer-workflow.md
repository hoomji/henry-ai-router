# Representative workflow

## Outcome

Add one new AI-router product idea to [`IDEA.md`](../../IDEA.md), or promote an existing
idea into a product specification under
[`docs/product-specs/index.md`](../product-specs/index.md).

This is the workflow this repository actually performs today. If an agent can complete it
end to end using only the repository — finding the authoritative file, making a scoped
edit, and proving the result with a command — the minimum harness is doing its job.

## Preconditions and boundary

- Required local state: a clean or intentionally dirty working tree, and Python 3.10+.
- Credentials or services: none. Every step runs offline.
- Maximum risk class: R1 (workspace edits only). No push, no PR, no shared state.
- Stop and escalate when: the change would add application code, choose an
  implementation language or framework, or contradict `IDEA.md` — those are ADR-level
  decisions, not routine edits.

## Steps

1. Read [`AGENTS.md`](../../AGENTS.md) to locate the authoritative file for the change.
2. Make the smallest in-scope edit: one idea, or one specification created from
   [`docs/product-specs/template.md`](../product-specs/template.md) and listed in its
   index in the same change.
3. Run the focused check, then the repository gate.
4. Review the diff and residual risk; leave the change unstaged for the maintainer.

## Acceptance criteria

- The new idea or specification exists in exactly one authoritative file, and any new
  store artifact is listed in its store index by the same change.
- `python scripts/check.py` exits 0, proving the harness contract holds and every
  repository-local Markdown link still resolves.
- No file outside the stated scope changed.

## Evidence

- Focused verification: `python scripts/harness-validate.py .` — expect
  `PASS: harness contract is internally consistent`.
- Repository gate: `python scripts/check.py` — expect `PASS: repository gate`.
- Runtime evidence: not applicable; this repository has no runtime.
- Handoff: changed artifacts, command results, skipped checks, and residual risks.
