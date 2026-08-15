# Core beliefs

The operating principles an agent should assume when it cannot find a more specific rule.
Adapt these to what this repository actually believes; delete any belief the repository
does not hold, and add the ones it does. A belief that no artifact or check backs up is a
wish — either back it or remove it.

## Evidence outranks assertion

A claim in a document is a lead. A path, a command result, or a test is evidence. When a
document and the code disagree, the code is the current truth and the document is a bug.

## Progressive disclosure over exhaustive context

The agent entrypoint is a map, not an encyclopedia. Each artifact holds one
responsibility and points to the next. Depth is reachable; it is not preloaded.

## One authoritative source per fact

Every fact has exactly one home. Duplicating it into a second document creates two facts
that will disagree. Link instead of copying.

## Plans are artifacts, not conversation

Work that outlives one session lives in a versioned plan with its own progress and
decision log, so a fresh agent can resume it from the repository alone.

## Mechanical enforcement over repeated correction

A rule that has been explained twice belongs in a lint, a test, a schema, or a CI gate
with a remediation message. Documentation is not enforcement.

## Honest unknowns over confident guesses

`unknown` is a valid, recordable answer. An invented command, a fabricated capability
claim, or a plausible path is worse than an admitted gap.

## Narrow, reversible changes

Prefer the smallest change that satisfies the request, verified by the narrowest relevant
check, in a group that can be reviewed and reverted on its own.

## Generated artifacts are outputs, never sources

Anything under `docs/generated/` is reproduced from a command. Edit the producer, then
regenerate.
