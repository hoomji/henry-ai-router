# Design documents

Catalogue of the design documentation an agent may rely on. Every file in this directory
appears in the table below exactly once.

Verification status vocabulary:

- `Proposed`: written, never checked against current code.
- `Verified`: checked against the named evidence on the recorded date.
- `Stale`: the named evidence no longer holds; treat the document as history.
- `Superseded`: replaced; the successor is linked in the document.

| Document | Scope | State | Owner | Last verified | Evidence |
|---|---|---|---|---|---|
| [Core beliefs](core-beliefs.md) | Agent-first operating principles | Proposed | henry.tran@uniblock.dev | Unverified | None |

## Entry contract

A design document explains how and why a part of the system is shaped the way it is. It
is not a specification, a plan, or a decision record.

- Required behavior belongs in `docs/product-specs/`.
- Execution sequence belongs in `docs/exec-plans/`.
- A hard-to-reverse architectural trade-off belongs in an ADR.
- The top-level component map belongs in the architecture entrypoint.

Each document names its scope, its owner, the evidence a reader can run or read to
confirm it still describes reality, and the date that evidence was last checked. Move a
document to `stale` rather than deleting it when its evidence stops holding.
