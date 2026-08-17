#!/usr/bin/env python3
"""Report documentation drift the repository gate cannot see.

`scripts/check.py` proves that links resolve and that the harness manifest is
consistent. Neither says anything about whether a document is still *true*. This
script covers the mechanical part of that gap — the angles where a wrong document
leaves a detectable trace — and the routine in `docs/harness/docs-audit.md` covers
the part that needs a reader.

It is advisory by default: it prints findings and exits 0, because "stale" is a
judgement and a nightly red gate nobody can fix teaches people to ignore the gate.
Pass `--strict` to exit non-zero when any finding is reported, which is what a
reviewer does when they want a claim adjudicated before merge.

Passes:
  claims      prose asserting a state of the world that the repository contradicts
  indexes     documents in an indexed store that their index does not list
  orphans     documents nothing else links to
  staleness   documents whose `Reviewed:` date is older than the freshness budget
  pointers    references to paths that moved (notably `exec-plans/active/`)
  markers     TODO / TBD / FIXME / placeholder text left in authored documentation
"""

from __future__ import annotations

import argparse
import datetime as dt
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIPPED_DIRECTORIES = {".git", "node_modules", "dist"}
LINK_PATTERN = re.compile(r"\[[^]]*\]\(([^)]+)\)")
URL_PATTERN = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://")
REVIEWED_PATTERN = re.compile(r"^-?\s*Reviewed:\s*`?(\d{4}-\d{2}-\d{2})`?", re.MULTILINE)
MARKER_PATTERN = re.compile(r"\b(TODO|TBD|FIXME|XXX|\[Filled in|\[team or person\])")

# Indexed knowledge stores: directory -> its index. Every authored document in the
# directory must appear in the index, because the index is what makes it authoritative.
INDEXED_STORES = {
    "docs/product-specs": "docs/product-specs/index.md",
    "docs/design-docs": "docs/design-docs/index.md",
    "docs/references": "docs/references/index.md",
    "docs/generated": "docs/generated/index.md",
}
INDEX_EXEMPT = {"template.md", "index.md"}

# A claim is a phrase whose truth the repository can contradict mechanically. Each entry
# is (regex, predicate name); the predicate returns a contradiction string, or None.
CLAIM_PATTERNS = [
    (re.compile(r"contains no implementation|no implementation exists|Not delivered", re.I), "no_implementation"),
    (re.compile(r"there is (still )?no CI|no CI (is )?running", re.I), "no_ci"),
    (re.compile(r"this repository has no runtime", re.I), "no_runtime"),
    (re.compile(r"not yet implemented|to be implemented|will be implemented", re.I), "unbuilt"),
]

FRESHNESS_DEFAULT_DAYS = 90


def markdown_files() -> list[Path]:
    return sorted(
        path
        for path in ROOT.rglob("*.md")
        if not SKIPPED_DIRECTORIES.intersection(path.relative_to(ROOT).parts)
    )


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


class Findings:
    def __init__(self) -> None:
        self.items: list[tuple[str, str]] = []

    def add(self, pass_name: str, message: str) -> None:
        self.items.append((pass_name, message))

    def report(self, pass_name: str, clean: str) -> None:
        found = [message for name, message in self.items if name == pass_name]
        print(f"--- {pass_name}")
        for message in found:
            print(f"  ? {message}")
        if not found:
            print(f"  PASS: {clean}")


def is_quoted(line: str, match: re.Match[str]) -> bool:
    """Whether a match sits inside quotes or backticks on its line.

    Recording what a document *used to* claim, or naming a path that has since moved, is
    how the learning ledger and the quality report do their job. Both quote the dead claim
    verbatim, so quoting is the suppression convention rather than a per-file exemption.
    """
    prefix = line[: match.start()]
    return prefix.count('"') % 2 == 1 or prefix.count("`") % 2 == 1


def repository_state() -> dict[str, bool]:
    """What the repository can prove about itself, for the claims pass."""
    return {
        "has_runtime": (ROOT / "gateway" / "src" / "server.ts").exists(),
        "has_ci": any((ROOT / ".github" / "workflows").glob("*.yml"))
        if (ROOT / ".github" / "workflows").exists()
        else False,
    }


def audit_claims(findings: Findings, files: list[Path]) -> None:
    state = repository_state()
    for path in files:
        # A completed ExecPlan is a dated record of what was true when it was written;
        # contradicting today's repository is its job, not a defect.
        if "exec-plans/completed" in rel(path):
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            for pattern, kind in CLAIM_PATTERNS:
                match = pattern.search(line)
                if match is None or is_quoted(line, match):
                    continue
                if kind in {"no_implementation", "no_runtime", "unbuilt"} and state["has_runtime"]:
                    findings.add(
                        "claims",
                        f"{rel(path)}:{number} claims nothing is built, but gateway/src/server.ts exists: {line.strip()[:90]}",
                    )
                if kind == "no_ci" and state["has_ci"]:
                    findings.add(
                        "claims",
                        f"{rel(path)}:{number} claims there is no CI, but .github/workflows carries a workflow: {line.strip()[:90]}",
                    )


def audit_indexes(findings: Findings) -> None:
    for directory, index_path in INDEXED_STORES.items():
        index_file = ROOT / index_path
        if not index_file.exists():
            findings.add("indexes", f"{index_path} is declared as an index and does not exist")
            continue
        index_text = index_file.read_text(encoding="utf-8")
        for document in sorted((ROOT / directory).glob("*.md")):
            if document.name in INDEX_EXEMPT:
                continue
            if document.name not in index_text:
                findings.add("indexes", f"{rel(document)} is not listed in {index_path}")


def audit_orphans(findings: Findings, files: list[Path]) -> None:
    linked: set[str] = set()
    for path in files:
        for raw in LINK_PATTERN.findall(path.read_text(encoding="utf-8")):
            target = raw.strip().strip("<>").split("#", 1)[0]
            if not target or URL_PATTERN.match(target):
                continue
            resolved = (path.parent / target).resolve()
            if resolved.exists():
                linked.add(resolved.as_posix())
    roots = {"README.md", "AGENTS.md", "CLAUDE.md", "ARCHITECTURE.md", "CONTEXT.md", "PLAN.md"}
    for path in files:
        if rel(path) in roots or path.name == "index.md":
            continue
        if path.resolve().as_posix() not in linked:
            findings.add("orphans", f"{rel(path)} is linked from nothing; either link it or delete it")


def audit_staleness(findings: Findings, files: list[Path], budget_days: int, today: dt.date) -> None:
    for path in files:
        match = REVIEWED_PATTERN.search(path.read_text(encoding="utf-8"))
        if not match:
            continue
        reviewed = dt.date.fromisoformat(match.group(1))
        age = (today - reviewed).days
        if age > budget_days:
            findings.add("staleness", f"{rel(path)} was reviewed {age} days ago ({reviewed}), over the {budget_days}-day budget")


def audit_pointers(findings: Findings, files: list[Path]) -> None:
    """Path references that survive a move because nothing resolves them as links.

    A YAML evidence path and a path inside a prose sentence or a code comment are both
    invisible to the link checker. This is the sweep the tracer plan's retrospective
    recommended after exactly that escape.
    """
    active = ROOT / "docs" / "exec-plans" / "active"
    live = {entry.name for entry in active.glob("*.md")} if active.exists() else set()
    text_files = files + sorted(
        path
        for suffix in ("*.yaml", "*.yml", "*.ts", "*.py")
        for path in ROOT.rglob(suffix)
        if not SKIPPED_DIRECTORIES.intersection(path.relative_to(ROOT).parts)
    )
    for path in text_files:
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for number, line in enumerate(content.splitlines(), 1):
            for match in re.finditer(r"exec-plans/active/([\w.-]+\.md)", line):
                reference = match.group(1)
                if reference not in live and not is_quoted(line, match):
                    findings.add(
                        "pointers",
                        f"{rel(path)}:{number} points at exec-plans/active/{reference}, which is no longer there",
                    )


def audit_markers(findings: Findings, files: list[Path]) -> None:
    for path in files:
        if path.name == "template.md" or rel(path).startswith("docs/exec-plans/tech-debt-tracker"):
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            match = MARKER_PATTERN.search(line)
            if match and not is_quoted(line, match):
                findings.add("markers", f"{rel(path)}:{number} carries `{match.group(0)}`: {line.strip()[:80]}")


def audit_untracked(findings: Findings) -> None:
    """Documents changed in the working tree, so a reader knows the audit's subject."""
    try:
        completed = subprocess.run(
            ["git", "status", "--porcelain", "--", "*.md"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return
    for line in completed.stdout.splitlines():
        print(f"  (uncommitted) {line.strip()}")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strict", action="store_true", help="exit non-zero when anything is found")
    parser.add_argument("--freshness-days", type=int, default=FRESHNESS_DEFAULT_DAYS)
    parser.add_argument("--today", default=None, help="override today's date (YYYY-MM-DD), for testing")
    arguments = parser.parse_args(argv)
    today = dt.date.fromisoformat(arguments.today) if arguments.today else dt.date.today()

    files = markdown_files()
    findings = Findings()
    audit_claims(findings, files)
    audit_indexes(findings)
    audit_orphans(findings, files)
    audit_staleness(findings, files, arguments.freshness_days, today)
    audit_pointers(findings, files)
    audit_markers(findings, files)

    print(f"Documentation audit over {len(files)} authored Markdown file(s).\n")
    findings.report("claims", "no document contradicts what the repository contains")
    findings.report("indexes", "every store document is listed in its index")
    findings.report("orphans", "every document is reachable from another")
    findings.report("staleness", f"every dated document is inside the {arguments.freshness_days}-day budget")
    findings.report("pointers", "no reference points at a moved ExecPlan")
    findings.report("markers", "no placeholder text left in authored documentation")
    print("\n--- working tree")
    audit_untracked(findings)

    total = len(findings.items)
    print(f"\n{total} finding(s). These are candidates for a reader to adjudicate, not failures.")
    print("Follow docs/harness/docs-audit.md for the passes this script cannot make.")
    return 1 if (arguments.strict and total) else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
