#!/usr/bin/env python3
"""Run the full repository gate: prerequisites, harness contract, and links.

This is the deterministic entrypoint behind `commands.test` in the harness
manifest. It shells out to the narrower entrypoints rather than duplicating
them, so a focused check and the full gate can never disagree.
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# The gate reads only what this repository authors. Installed packages and build output
# are neither ours to fix nor stable between checkouts.
SKIPPED_DIRECTORIES = {".git", "node_modules", "dist"}
LINK_PATTERN = re.compile(r"\[[^]]*\]\(([^)]+)\)")
URL_PATTERN = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*://")


def run(label: str, command: list[str]) -> bool:
    print(f"--- {label}: {' '.join(command)}", flush=True)
    completed = subprocess.run(command, cwd=ROOT)
    return completed.returncode == 0


def markdown_files() -> list[Path]:
    return sorted(
        path
        for path in ROOT.rglob("*.md")
        if not SKIPPED_DIRECTORIES.intersection(path.relative_to(ROOT).parts)
    )


def check_links() -> bool:
    print("--- links: every repository-local Markdown link resolves")
    broken: list[str] = []
    for path in markdown_files():
        text = path.read_text(encoding="utf-8")
        for raw in LINK_PATTERN.findall(text):
            target = raw.strip().strip("<>").split("#", 1)[0]
            if not target or URL_PATTERN.match(target):
                continue
            resolved = (path.parent / target).resolve()
            if not resolved.exists():
                broken.append(f"{path.relative_to(ROOT).as_posix()} -> {target}")
    for entry in broken:
        print(f"ERROR broken link: {entry}")
    if broken:
        print(f"FAIL: {len(broken)} broken link(s).")
        return False
    print(f"PASS: links resolve across {len(markdown_files())} Markdown file(s).")
    return True


def main() -> int:
    results = [
        run("setup", [sys.executable, "scripts/setup.py"]),
        run("harness", [sys.executable, "scripts/harness-validate.py", "."]),
        check_links(),
    ]
    if not all(results):
        print(f"FAIL: repository gate failed ({results.count(False)} of {len(results)}).")
        return 1
    print(f"PASS: repository gate ({len(results)} of {len(results)}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
