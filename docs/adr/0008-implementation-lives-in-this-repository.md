# The gateway implementation lives in this repository

Status: accepted (2026-08-15)

`ARCHITECTURE.md` stated that this repository owns product *thinking* and no
implementation, and that adding one "is an architectural change that belongs in an ADR
rather than in a routine edit." M1 of the tracer ExecPlan adds one, so that ADR is owed
before the boundary changes rather than after.

The choice itself was made during planning and recorded in the tracer ExecPlan's Decision
Log on 2026-08-14. This record exists because a Decision Log entry is scoped to one plan,
while the repository boundary outlives every plan that crosses it.

The gateway implementation lives here, in a new top-level `gateway/` directory: TypeScript
on Node.js 24 or newer, compiled with `tsc`, with zero runtime dependencies. The one-way
dependency direction already stated in `ARCHITECTURE.md` gains a component rather than an
exception — `scripts/` validates `docs/`, neither reads `gateway/`, and `gateway/` reads
neither. The Python harness scripts remain the repository's validation and gate entrypoints
and are unaffected by the runtime's language.

## Considered options

**A separate implementation repository.** Rejected. The harness that governs this work —
the product specification, the ExecPlans, the validation and gate commands, the ADRs — is
already here, and the specification is the document an implementer most needs open while
writing this code. A second repository would duplicate that harness and split review across
two places, for a separation nobody has yet needed.

**This repository, as decided.** The cost is that a documentation gate now runs over a tree
containing a build. That is tolerable because the two do not overlap: the harness scripts
read Markdown and YAML, and the gateway's own checks are npm scripts. If they ever do
overlap, the honest fix is to split the repository rather than to weaken either gate.

TypeScript over Rust or Go is a separate decision with its own reasoning, recorded in the
tracer ExecPlan's Decision Log and not restated here.

## Consequences

- `ARCHITECTURE.md`'s system boundary and component table now list `gateway/`, and its
  "no implementation" claim is retired.
- The harness manifest's `startable_runtime` and `automated_tests` capabilities move from
  `missing` to `verified`, with the start, stub, and test commands as evidence.
- `AGENTS.md` carries two command sets — the Python harness commands and the gateway's npm
  commands — and must keep saying which is which. A single merged list would invite running
  the wrong one against the wrong tree.
- Reverting is a directory deletion plus three documentation edits. Nothing in `docs/`
  depends on `gateway/` existing.

## Residual assumption

One development dependency beyond `typescript` was necessary: `@types/node`, without which
`node:http` and the global `fetch` do not typecheck. It is development-only, so the runtime
dependency count stays at zero — which is the constraint the ExecPlan actually protects. The
assumption is that this stays true: a runtime dependency would need its own Decision Log
entry, and a second development dependency is worth noticing rather than waving through.
