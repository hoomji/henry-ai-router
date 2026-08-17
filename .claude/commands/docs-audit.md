---
description: Audit this repository's documentation for drift and fix what is wrong
---

Run the documentation audit routine in `docs/harness/docs-audit.md`. Read it first and
follow all four steps in order — the mechanical script, the four reader passes, the fixes,
and the gate plus the report.

Scope from the user, if any: $ARGUMENTS

If a scope is named, still run step 1 over the whole repository (it is fast and its output
frames everything else), then narrow steps 2 and 3 to that scope and say in the report what
you left unchecked.
