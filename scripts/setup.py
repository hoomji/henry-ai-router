#!/usr/bin/env python3
"""Verify the prerequisites needed to work in this repository.

Setup is a check, not an installation: the harness itself needs only a supported
Python interpreter, and it stays honest by failing when that is absent.

The two runtimes -- the gateway under gateway/ and the connector under connector/ --
have their own dependencies and their own installers (npm --prefix <name> install).
This script deliberately does not run them -- a documentation change should not
require a package manager -- but it does report whether each has been installed, so a
missing build is visible here rather than discovered at the first start command.
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
    print("No dependencies to install for the harness itself.")

    for label, package in (("Gateway", "gateway"), ("Connector", "connector")):
        if (root / package / "node_modules").is_dir():
            print(f"{label} runtime: dependencies installed.")
        else:
            print(
                f"{label} runtime: not installed. "
                f"Run 'npm --prefix {package} install' "
                f"before 'npm --prefix {package} run build'."
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
