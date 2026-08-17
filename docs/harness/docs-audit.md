# Documentation audit routine

Check the repository's documentation from every angle that can make it wrong, and fix what
is wrong in the same pass. Agent-neutral: any agent or person can run this. Claude Code
users can invoke it as `/docs-audit`, which is a thin pointer at this file
([`.claude/commands/docs-audit.md`](../../.claude/commands/docs-audit.md)) and carries no
guidance of its own.

The repository gate already proves two things, and nothing more: that every
repository-local Markdown link resolves, and that the harness manifest and the store
indexes agree. **Neither says a document is still true.** A document that is fluent,
well-linked, indexed, and false passes the gate. This routine exists for that gap.

Run it after a milestone lands, before retiring an ExecPlan, before a review that will
trust the documentation, and whenever a claim in a document surprises you.

## Step 1 — mechanical passes

```bash
python scripts/docs-audit.py
```

It reports six classes of drift and exits 0; findings are candidates for adjudication, not
failures. Pass `--strict` to make any finding non-zero when you want a claim settled before
a merge. Substitute `py` if that is the interpreter your machine has.

| Pass | What it catches | Why a script can catch it |
|---|---|---|
| `claims` | Prose saying nothing is built, or that no CI exists | The repository contradicts it: `gateway/src/server.ts` and `.github/workflows/` are either there or not |
| `indexes` | A store document its index does not list | Nothing in a knowledge store is authoritative unless its index lists it |
| `orphans` | A document nothing links to | Unreachable documentation is not read, so it rots unobserved |
| `staleness` | A `Reviewed:` date past the freshness budget | The manifest declares `review_after_days: 90` |
| `pointers` | A path reference to a moved ExecPlan, in Markdown, YAML, TypeScript or Python | The link checker reads Markdown links only; a path in a comment or a YAML value survives a move silently |
| `markers` | `TODO`, `TBD`, `FIXME`, or template placeholder text | A placeholder that shipped is an unfinished document claiming to be finished |

Suppression is by quoting: a claim or a path inside `"quotes"` or `` `backticks` `` is
skipped, because recording what a document *used to* say is exactly the job of
[`learning-ledger.md`](learning-ledger.md) and [`quality-report.md`](quality-report.md).
There are no per-file exemptions to keep in sync.

## Step 2 — the passes that need a reader

The script cannot tell whether prose matches behavior. These four passes are why this
routine is a routine and not just a script. Work them in order; each is cheaper when the
one before it has been done.

**Delivery status.** For every product spec, compare its `State`, its ticked acceptance
criteria and its *Delivery evidence* section against what is actually merged. The evidence
must name a command, a merged change, or a runtime surface — never an adjective. A criterion
is ticked only when a named artifact proves it. Equally important, and more often skipped:
write down what the evidence does **not** establish. Every check in this repository runs
against simulated providers, and a spec that omits that says something false by silence.

**Prose against code.** Pick the claims a document makes about the runtime and check each
against the source, not against another document. The high-value targets are command lists
in [`AGENTS.md`](../../AGENTS.md), environment variables (`gateway/src/config.ts` and
`connector/src/config.ts` are the only modules that read the environment, so they are the
authority), HTTP routes, and file layout in
[`gateway-design.md`](../design-docs/gateway-design.md). A command in `AGENTS.md` that is
not in the relevant `package.json` is a defect; so is a `package.json` script that no
document mentions.

**Numbers and dates.** Counted claims decay silently: test counts, check counts, timings,
measured splits. Re-run the command or attribute the number to the dated run that produced
it. A number with a date attached ages honestly; a bare number becomes a lie.

**Cross-document agreement.** The same fact is stated in several places by design — the
manifest, the quality report, the spec, the ExecPlans, `AGENTS.md`. Pick the facts that
appear more than once and confirm they still agree, then make one of them the authority and
have the others point at it rather than restate it. Duplication is how the next drift gets
in.

## Step 3 — fix, in the same change

Fix what you found rather than filing it, with three exceptions: work that needs a decision
belongs in an ADR, work that is larger than the audit belongs in
[`tech-debt-tracker.md`](../exec-plans/tech-debt-tracker.md), and a claim you cannot
adjudicate belongs in the audit's report as an open question with the evidence you have.

When correcting a claim, prefer narrowing to deleting. "Not delivered" became "partially
delivered, behaviors 1 and 4, proven by these commands, and here is what that does not
prove" — which is more useful than either the false claim or its absence. Keep the
superseded claim visible where a reader would otherwise wonder what changed, in quotes so
the mechanical pass leaves it alone.

If the same drift has now appeared twice, it is no longer a documentation fix: add an entry
to [`learning-ledger.md`](learning-ledger.md), and encode it as a pass in
`scripts/docs-audit.py` if a check can see it. That is the routine's own growth path — every
mechanical pass in step 1 exists because something escaped a human reading first.

## Step 4 — verify and report

```bash
python scripts/check.py
```

The gate must pass; documentation edits break links more often than anything else here.
Then report, in this shape:

- What was checked, by pass, and what was found.
- What was fixed, with the file and the claim as it now reads.
- What was **not** fixed and why: the open questions, the claims you could not adjudicate,
  and the passes you skipped.

A documentation audit that reports only fixes is the same failure mode as the documents it
audits.
