#!/usr/bin/env python3
"""Verify the prerequisites needed to work in this repository.

This repository holds documentation only: there is nothing to install. Setup is
therefore a check, not an installation, and it stays honest by failing when the
one real prerequisite -- a supported Python interpreter -- is absent.
"""

from __future__ import annotations

import sys
from pathlib import Path

MINIMUM_PYTHON = (3, 10)
REQUIRED_PATHS = (
    "docs/harness/manifest.yaml",
    "scripts/harness-validate.py",
)


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    failures: list[str] = []

    if sys.version_info < MINIMUM_PYTHON:
        failures.append(
            f"Python {'.'.join(map(str, MINIMUM_PYTHON))}+ is required, "
            f"found {sys.version.split()[0]}."
        )

    for relative in REQUIRED_PATHS:
        if not (root / relative).is_file():
            failures.append(f"{relative} is absent.")

    for failure in failures:
        print(f"ERROR {failure}")
    if failures:
        print(f"FAIL: setup prerequisites unmet ({len(failures)} problem(s)).")
        return 1

    print(f"PASS: Python {sys.version.split()[0]} is supported.")
    print("No dependencies to install: this repository contains documentation only.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
