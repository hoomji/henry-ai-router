# Generated documentation

Machine-produced documentation. Nothing in this directory is edited by hand: change the
producer, then regenerate. Every file here appears in the table below.

| Artifact | Describes | Producing command | Producer source | Last generated |
|---|---|---|---|---|

_No generated artifacts._

## Entry contract

Every generated file starts with a provenance header, using the comment syntax of its
format, containing both markers verbatim:

    <!-- Do not edit. Generated file. -->
    <!-- Producing command: `make docs-db-schema` -->

The producing command must be a real repository entrypoint — a task-runner target, a
package script, or a repository-owned script — so a broken producer is detectable rather
than merely stale.

- Regeneration is part of the change that alters the source, not a separate cleanup.
- A generated artifact is never the authoritative source for a decision; link the
  producer or the underlying code instead.
- Delete the artifact and its row together when its producer is removed.
