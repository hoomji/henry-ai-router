#!/usr/bin/env python3
"""Validate the repository-local minimum harness contract without dependencies."""

from __future__ import annotations

import argparse
import json
import re
import shlex
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ALLOWED_CAPABILITY_STATUSES = {
    "missing",
    "documented",
    "executable",
    "verified",
    "automated",
}
EVIDENCE_REQUIRED_STATUSES = {"verified", "automated"}
REQUIRED_ENTRYPOINTS = ("guidance", "architecture", "design", "tracer")
REQUIRED_COMMANDS = ("setup", "start", "check", "test", "validate")
LEDGER_MARKERS = (
    "Observed friction",
    "Missing harness plane",
    "Closure evidence",
    "Review date",
)
PRODUCER_PATTERN = re.compile(r"Producing command:\s*`([^`]+)`")


class YamlSubsetError(ValueError):
    pass


@dataclass(frozen=True)
class Token:
    indent: int
    text: str
    line: int


@dataclass(frozen=True)
class StoreSpec:
    """Structural contract for one knowledge store declared in the manifest."""

    key: str
    index_markers: tuple[str, ...] = ()
    member_markers: tuple[str, ...] = ()
    member_suffixes: tuple[str, ...] | None = (".md",)
    required_files: tuple[str, ...] = ()
    required_dirs: tuple[str, ...] = ()
    root_allowlist: tuple[str, ...] | None = None
    check_producer: bool = False


KNOWLEDGE_STORES = (
    # The design index also passes through the entrypoints.design contract, which already
    # enforces its state, owner, last-verified, and evidence fields.
    StoreSpec(key="design_docs"),
    StoreSpec(
        key="exec_plans",
        index_markers=("Active", "Completed"),
        required_files=("tech-debt-tracker.md",),
        required_dirs=("active", "completed"),
        root_allowlist=("tech-debt-tracker.md",),
    ),
    StoreSpec(
        key="generated",
        index_markers=("Producing command",),
        member_markers=("Do not edit", "Producing command:"),
        member_suffixes=None,
        check_producer=True,
    ),
    StoreSpec(key="product_specs", index_markers=("State",)),
    StoreSpec(
        key="references",
        index_markers=("Source", "Review"),
        member_markers=("Source:", "Retrieved:"),
    ),
)


def unquoted_characters(text: str) -> Iterator[tuple[int, str]]:
    quote: str | None = None
    escaped = False
    for index, character in enumerate(text):
        if escaped:
            escaped = False
            continue
        if character == "\\" and quote == '"':
            escaped = True
            continue
        if character in {"'", '"'}:
            quote = (
                None if quote == character else character if quote is None else quote
            )
            continue
        if quote is None:
            yield index, character


def strip_comment(line: str) -> str:
    for index, character in unquoted_characters(line):
        if character == "#" and (index == 0 or line[index - 1].isspace()):
            return line[:index].rstrip()
    return line.rstrip()


def split_pair(text: str, line: int) -> tuple[str, str]:
    for index, character in unquoted_characters(text):
        if character == ":":
            key = text[:index].strip()
            if not re.fullmatch(r"[A-Za-z0-9_.-]+", key):
                raise YamlSubsetError(f"line {line}: invalid mapping key {key!r}")
            return key, text[index + 1 :].strip()
    raise YamlSubsetError(f"line {line}: expected 'key: value'")


def parse_scalar(text: str, line: int) -> Any:
    if text == "{}":
        return {}
    if text == "[]":
        return []
    if text in {"null", "~"}:
        return None
    if text in {"true", "false"}:
        return text == "true"
    if re.fullmatch(r"-?[0-9]+", text):
        return int(text)
    if text.startswith('"'):
        try:
            return json.loads(text)
        except json.JSONDecodeError as error:
            raise YamlSubsetError(
                f"line {line}: invalid quoted string: {error.msg}"
            ) from error
    if text.startswith("'"):
        if not text.endswith("'"):
            raise YamlSubsetError(f"line {line}: unterminated quoted string")
        return text[1:-1].replace("''", "'")
    if any(marker in text for marker in ("&", "*", "!", "{|", "[|")):
        raise YamlSubsetError(f"line {line}: unsupported YAML feature")
    return text


class YamlSubsetParser:
    """Parse the mappings, lists, and scalars used by the harness manifest."""

    def __init__(self, text: str) -> None:
        self.tokens: list[Token] = []
        for line_number, raw_line in enumerate(text.splitlines(), start=1):
            line = strip_comment(raw_line)
            if not line.strip():
                continue
            leading = len(line) - len(line.lstrip(" "))
            if "\t" in line[:leading] or leading % 2:
                raise YamlSubsetError(
                    f"line {line_number}: indentation must use pairs of spaces"
                )
            self.tokens.append(Token(leading, line.lstrip(), line_number))

    def parse(self) -> Any:
        if not self.tokens:
            raise YamlSubsetError("manifest is empty")
        value, index = self.parse_block(0, self.tokens[0].indent)
        if index != len(self.tokens):
            token = self.tokens[index]
            raise YamlSubsetError(f"line {token.line}: unexpected indentation")
        return value

    def parse_block(self, index: int, indent: int) -> tuple[Any, int]:
        if self.tokens[index].indent != indent:
            token = self.tokens[index]
            raise YamlSubsetError(f"line {token.line}: unexpected indentation")
        if self.tokens[index].text.startswith("- "):
            return self.parse_list(index, indent)
        return self.parse_mapping(index, indent)

    def parse_mapping(self, index: int, indent: int) -> tuple[dict[str, Any], int]:
        result: dict[str, Any] = {}
        while index < len(self.tokens):
            token = self.tokens[index]
            if token.indent < indent:
                break
            if token.indent > indent:
                raise YamlSubsetError(f"line {token.line}: unexpected indentation")
            if token.text.startswith("- "):
                break
            key, raw_value = split_pair(token.text, token.line)
            if key in result:
                raise YamlSubsetError(f"line {token.line}: duplicate key {key!r}")
            index += 1
            if raw_value:
                result[key] = parse_scalar(raw_value, token.line)
            elif index < len(self.tokens) and self.tokens[index].indent > indent:
                result[key], index = self.parse_block(index, self.tokens[index].indent)
            else:
                result[key] = None
        return result, index

    def parse_list(self, index: int, indent: int) -> tuple[list[Any], int]:
        result: list[Any] = []
        while index < len(self.tokens):
            token = self.tokens[index]
            if token.indent < indent:
                break
            if token.indent != indent or not token.text.startswith("- "):
                break
            raw_item = token.text[2:].strip()
            index += 1
            if not raw_item:
                if index >= len(self.tokens) or self.tokens[index].indent <= indent:
                    raise YamlSubsetError(f"line {token.line}: empty list item")
                nested_item, index = self.parse_block(index, self.tokens[index].indent)
                result.append(nested_item)
                continue
            if re.match(r"[A-Za-z0-9_.-]+\s*:", raw_item):
                key, raw_value = split_pair(raw_item, token.line)
                mapping_item: dict[str, Any] = {
                    key: parse_scalar(raw_value, token.line) if raw_value else None
                }
                if index < len(self.tokens) and self.tokens[index].indent > indent:
                    continuation, index = self.parse_mapping(
                        index, self.tokens[index].indent
                    )
                    overlap = set(mapping_item) & set(continuation)
                    if overlap:
                        raise YamlSubsetError(
                            f"line {token.line}: duplicate key {sorted(overlap)[0]!r}"
                        )
                    mapping_item.update(continuation)
                result.append(mapping_item)
            else:
                result.append(parse_scalar(raw_item, token.line))
        return result, index


def add_error(errors: list[str], code: str, message: str, remediation: str) -> None:
    errors.append(f"ERROR [{code}] {message} Remediation: {remediation}")


def repository_path(
    root: Path,
    value: Any,
    label: str,
    errors: list[str],
) -> Path | None:
    if not isinstance(value, str) or not value or value == "unknown":
        add_error(
            errors,
            "path.invalid",
            f"{label} must be a repository-relative path, got {value!r}.",
            "Record an existing authoritative file or create it before validation.",
        )
        return None
    path = Path(value)
    if path.is_absolute() or ".." in path.parts:
        add_error(
            errors,
            "path.unsafe",
            f"{label} points outside the repository: {value!r}.",
            "Use a repository-relative path without '..'.",
        )
        return None
    resolved = root / path
    if not resolved.is_file():
        add_error(
            errors,
            "path.missing",
            f"{label} does not resolve to a file: {value!r}.",
            "Fix the pointer or add the referenced authoritative file.",
        )
        return None
    return resolved


def package_scripts(root: Path) -> dict[str, str] | None:
    package = root / "package.json"
    try:
        parsed = json.loads(package.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    scripts = parsed.get("scripts")
    return scripts if isinstance(scripts, dict) else None


def make_targets(root: Path) -> set[str]:
    try:
        text = (root / "Makefile").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return set()
    return set(re.findall(r"^([A-Za-z0-9_.-]+):(?:\s|$)", text, re.MULTILINE))


def validate_command(
    root: Path,
    label: str,
    command: Any,
    errors: list[str],
    warnings: list[str],
    *,
    allow_unknown: bool = False,
) -> None:
    if command == "unknown":
        if allow_unknown:
            warnings.append(
                f"WARN [{label}] command is explicitly unknown; this repository may have no startable runtime."
            )
        else:
            add_error(
                errors,
                "command.unknown",
                f"{label} cannot remain 'unknown' in a minimum harness.",
                "Add a deterministic repository entrypoint before declaring bootstrap complete.",
            )
        return
    if not isinstance(command, str) or not command.strip():
        add_error(
            errors,
            "command.invalid",
            f"{label} must be a non-empty command or 'unknown'.",
            "Record the exact repository command, or use 'unknown' honestly.",
        )
        return
    try:
        words = shlex.split(command)
    except ValueError as error:
        add_error(
            errors,
            "command.syntax",
            f"{label} cannot be parsed: {error}.",
            "Fix the shell quoting in the manifest.",
        )
        return
    while words and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", words[0]):
        words.pop(0)
    if not words:
        add_error(
            errors,
            "command.empty",
            f"{label} contains only environment assignments.",
            "Add the command that should run after the assignments.",
        )
        return

    program = words[0]
    if program == "make" and len(words) > 1:
        targets = [
            word for word in words[1:] if not word.startswith("-") and "=" not in word
        ]
        if not (root / "Makefile").is_file():
            add_error(
                errors,
                "command.makefile",
                f"{label} uses make but Makefile is absent.",
                "Add the Makefile or correct the command.",
            )
        for target in targets:
            if target not in make_targets(root):
                add_error(
                    errors,
                    "command.make-target",
                    f"{label} references missing make target {target!r}.",
                    f"Add target '{target}' or correct the manifest command.",
                )
        return

    if program in {"npm", "pnpm", "yarn", "bun"}:
        script_index = 2 if len(words) > 1 and words[1] == "run" else 1
        if script_index >= len(words):
            add_error(
                errors,
                "command.package-script",
                f"{label} does not name a package script.",
                "Name an existing package.json script so the entrypoint can be checked.",
            )
            return
        script = words[script_index]
        scripts = package_scripts(root)
        if scripts is None:
            add_error(
                errors,
                "command.package",
                f"{label} references {program} but package.json scripts are unavailable.",
                "Add package.json or correct the command.",
            )
        elif script not in scripts:
            add_error(
                errors,
                "command.package-script",
                f"{label} references missing package script {script!r}.",
                f"Add script '{script}' or correct the manifest command.",
            )
        return

    candidate: str | None = None
    if program.startswith(".") or "/" in program:
        candidate = program
    elif program.startswith("python"):
        candidate = next((word for word in words[1:] if word.endswith(".py")), None)
    if candidate:
        path = Path(candidate)
        if path.is_absolute() or ".." in path.parts or not (root / path).is_file():
            add_error(
                errors,
                "command.path",
                f"{label} references missing or unsafe command path {candidate!r}.",
                "Use an existing repository-relative executable or script path.",
            )
        return
    add_error(
        errors,
        "command.opaque",
        f"{label} uses a tool form the validator cannot check statically: {command!r}.",
        "Expose this operation through a task-runner target or repository-owned script so a broken entrypoint is detectable.",
    )


def local_links(path: Path) -> Iterator[tuple[str, Path]]:
    """Yield each repository-local Markdown link as (raw target, resolved path)."""
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        return
    for raw in re.findall(r"\[[^]]*\]\(([^)]+)\)", text):
        target = raw.strip().strip("<>").split("#", 1)[0]
        if not target or re.match(r"[A-Za-z][A-Za-z0-9+.-]*://", target):
            continue
        linked = Path(target)
        yield target, (
            linked if linked.is_absolute() else path.parent / linked
        ).resolve()


def validate_markdown_links(path: Path, root: Path, errors: list[str]) -> None:
    for target, resolved in local_links(path):
        try:
            resolved.relative_to(root.resolve())
        except ValueError:
            add_error(
                errors,
                "guidance.link-outside",
                f"{path.relative_to(root)} links outside the repository: {target!r}.",
                "Link to a repository-owned source or an explicit HTTPS source.",
            )
            continue
        if not resolved.exists():
            add_error(
                errors,
                "guidance.broken-link",
                f"{path.relative_to(root)} contains broken link {target!r}.",
                "Fix or remove the stale pointer.",
            )


def missing_markers(text: str, markers: tuple[str, ...]) -> list[str]:
    """Report absent markers, ignoring Markdown emphasis and letter case."""
    haystack = re.sub(r"[*_`]", "", text).casefold()
    return [
        marker
        for marker in markers
        if re.sub(r"[*_`]", "", marker).casefold() not in haystack
    ]


def store_members(index: Path, spec: StoreSpec) -> list[Path]:
    """Return the artifact files a store index is responsible for cataloguing."""
    members: list[Path] = []
    for path in sorted(index.parent.rglob("*")):
        try:
            if not path.is_file() or path.is_symlink() or path == index:
                continue
        except OSError:
            continue
        if path.name == ".gitkeep":
            continue
        if spec.member_suffixes and path.suffix.lower() not in spec.member_suffixes:
            continue
        members.append(path)
    return members


def validate_store_member(
    root: Path,
    spec: StoreSpec,
    index: Path,
    member: Path,
    linked: set[Path],
    errors: list[str],
    warnings: list[str],
) -> None:
    label = member.relative_to(root).as_posix()
    if member.resolve() not in linked:
        add_error(
            errors,
            "store.unlisted",
            f"{label} is not listed in {index.relative_to(root).as_posix()}.",
            "Add the artifact to its store index, or remove the orphaned file.",
        )
    if spec.root_allowlist is not None and member.parent == index.parent:
        if member.name not in spec.root_allowlist:
            add_error(
                errors,
                "store.location",
                f"{label} sits at the store root instead of a lifecycle directory.",
                f"Move it into one of {list(spec.required_dirs)}, or record it as a store-root file.",
            )
    if not spec.member_markers and not spec.check_producer:
        return
    try:
        text = member.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        add_error(
            errors,
            "store.unreadable",
            f"{label} cannot be read as UTF-8 text but requires a provenance header.",
            "Store binary output outside the documentation knowledge store.",
        )
        return
    missing = missing_markers(text, spec.member_markers)
    if missing:
        add_error(
            errors,
            "store.provenance",
            f"{label} is missing required markers: {', '.join(missing)}.",
            f"Restore the entry contract recorded in {index.relative_to(root).as_posix()}.",
        )
    if not spec.check_producer or "Producing command:" not in text:
        return
    match = PRODUCER_PATTERN.search(text)
    if not match:
        add_error(
            errors,
            "store.producer",
            f"{label} does not name its producing command in backticks.",
            "Write the header as 'Producing command: `<exact command>`'.",
        )
        return
    validate_command(
        root, f"{label} producing command", match.group(1), errors, warnings
    )


def validate_store(
    root: Path,
    spec: StoreSpec,
    index: Path,
    errors: list[str],
    warnings: list[str],
) -> None:
    label = index.relative_to(root).as_posix()
    validate_markdown_links(index, root, errors)
    try:
        index_text = index.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        index_text = ""
    missing = missing_markers(index_text, spec.index_markers)
    if missing:
        add_error(
            errors,
            "store.index-contract",
            f"{label} is missing required sections: {', '.join(missing)}.",
            "Restore the store index contract from the bundled knowledge-store template.",
        )
    for name in spec.required_files:
        if not (index.parent / name).is_file():
            add_error(
                errors,
                "store.missing-file",
                f"{index.parent.relative_to(root).as_posix()}/{name} is absent.",
                "Add the bundled template for this store file.",
            )
    for name in spec.required_dirs:
        if not (index.parent / name).is_dir():
            add_error(
                errors,
                "store.missing-directory",
                f"{index.parent.relative_to(root).as_posix()}/{name}/ is absent.",
                "Create the lifecycle directory, keeping it tracked with a .gitkeep file.",
            )

    lifecycle: dict[str, set[str]] = {}
    for name in spec.required_dirs:
        directory = index.parent / name
        lifecycle[name] = (
            {path.name for path in directory.glob("*.md")}
            if directory.is_dir()
            else set()
        )
    for name, names in lifecycle.items():
        for other, other_names in lifecycle.items():
            if other <= name:
                continue
            for duplicate in sorted(names & other_names):
                add_error(
                    errors,
                    "store.lifecycle-duplicate",
                    f"{duplicate} exists in both {name}/ and {other}/ of {index.parent.relative_to(root).as_posix()}.",
                    "Keep each artifact in exactly one lifecycle directory.",
                )

    linked = {resolved for _, resolved in local_links(index)}
    for member in store_members(index, spec):
        validate_store_member(root, spec, index, member, linked, errors, warnings)


def validate_knowledge_store(
    root: Path,
    manifest: dict[str, Any],
    guidance: Path | None,
    guidance_text: str,
    errors: list[str],
    warnings: list[str],
) -> None:
    declared = manifest.get("knowledge_store")
    if not isinstance(declared, dict):
        add_error(
            errors,
            "knowledge-store.type",
            "knowledge_store must be a mapping of store name to index path.",
            f"Declare {[spec.key for spec in KNOWLEDGE_STORES]} using the bundled manifest template.",
        )
        return
    specs = {spec.key: spec for spec in KNOWLEDGE_STORES}
    for key in specs:
        if key not in declared:
            add_error(
                errors,
                "knowledge-store.missing",
                f"knowledge_store.{key} is not declared.",
                "Install the store index from the bundled knowledge-store templates and declare its path.",
            )
    for key, value in declared.items():
        index = repository_path(root, value, f"knowledge_store.{key}", errors)
        if index is None:
            continue
        if guidance and isinstance(value, str) and value not in guidance_text:
            add_error(
                errors,
                "guidance.knowledge-store",
                f"knowledge_store.{key} is not advertised in {guidance.relative_to(root)}.",
                "Point the shared agent map at every knowledge store so agents can find it.",
            )
        spec = specs.get(key)
        if spec:
            validate_store(root, spec, index, errors, warnings)


def validate_manifest(root: Path, manifest: Any) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    if not isinstance(manifest, dict):
        add_error(
            errors,
            "manifest.type",
            "manifest root must be a mapping.",
            "Use the bundled manifest template.",
        )
        return errors, warnings
    if manifest.get("version") != 1:
        add_error(
            errors,
            "manifest.version",
            f"version must be 1, got {manifest.get('version')!r}.",
            "Set 'version: 1'.",
        )

    owners = manifest.get("owners")
    if not isinstance(owners, dict) or owners.get("harness") in {None, "", "unknown"}:
        add_error(
            errors,
            "owners.harness",
            "owners.harness must name a real owner.",
            "Name the team or person responsible for harness freshness.",
        )

    entrypoints = manifest.get("entrypoints")
    entrypoint_paths: dict[str, Path] = {}
    if not isinstance(entrypoints, dict):
        add_error(
            errors,
            "entrypoints.type",
            "entrypoints must be a mapping.",
            "Add guidance, architecture, design, and tracer paths.",
        )
    else:
        for name in REQUIRED_ENTRYPOINTS:
            path = repository_path(
                root, entrypoints.get(name), f"entrypoints.{name}", errors
            )
            if path:
                entrypoint_paths[name] = path

    guidance = entrypoint_paths.get("guidance")
    guidance_text = ""
    if guidance:
        try:
            guidance_text = guidance.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            pass
        validate_markdown_links(guidance, root, errors)

    claude = root / "CLAUDE.md"
    if claude.is_file():
        try:
            claude_text = claude.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            claude_text = ""
        if "AGENTS.md" not in claude_text:
            add_error(
                errors,
                "guidance.claude-route",
                "CLAUDE.md does not route readers to AGENTS.md.",
                "Preserve Claude-only guidance, but add a clear pointer to the shared AGENTS.md map.",
            )


    design = entrypoint_paths.get("design")
    if design:
        validate_markdown_links(design, root, errors)
        try:
            design_text = design.read_text(encoding="utf-8").lower()
        except (OSError, UnicodeDecodeError):
            design_text = ""
        for marker in ("state", "owner", "last verified", "evidence"):
            if marker not in design_text:
                add_error(
                    errors,
                    "design-index.contract",
                    f"entrypoints.design does not name {marker}.",
                    "Add state, owner, last verified, and evidence columns or fields to the design-doc index.",
                )
    tracer = entrypoint_paths.get("tracer")
    if tracer:
        try:
            tracer_text = tracer.read_text(encoding="utf-8").lower()
        except (OSError, UnicodeDecodeError):
            tracer_text = ""
        for marker in ("acceptance", "evidence"):
            if marker not in tracer_text:
                add_error(
                    errors,
                    "tracer.contract",
                    f"entrypoints.tracer does not name {marker}.",
                    "Add explicit acceptance criteria and reproducible evidence to the tracer workflow.",
                )

    capabilities = manifest.get("capabilities")
    runtime_capability = (
        capabilities.get("startable_runtime")
        if isinstance(capabilities, dict)
        else None
    )
    no_startable_runtime = (
        isinstance(runtime_capability, dict)
        and runtime_capability.get("status") == "missing"
        and isinstance(runtime_capability.get("evidence"), list)
        and bool(runtime_capability["evidence"])
    )

    commands = manifest.get("commands")
    if not isinstance(commands, dict):
        add_error(
            errors,
            "commands.type",
            "commands must be a mapping.",
            "Add setup, start, check, test, and validate declarations.",
        )
    else:
        for name in REQUIRED_COMMANDS:
            command = commands.get(name)
            if name == "start" and command == "unknown" and not no_startable_runtime:
                add_error(
                    errors,
                    "command.start-unknown",
                    "commands.start is unknown without evidence that the repository has no startable runtime.",
                    "Add a deterministic start command, or declare capabilities.startable_runtime as missing with repository evidence.",
                )
            else:
                validate_command(
                    root,
                    f"commands.{name}",
                    command,
                    errors,
                    warnings,
                    allow_unknown=name == "start" and no_startable_runtime,
                )
            if guidance and isinstance(command, str) and command not in guidance_text:
                add_error(
                    errors,
                    "guidance.command",
                    f"commands.{name} is not advertised verbatim in {guidance.relative_to(root)}.",
                    "Add the exact manifest command to the shared agent map.",
                )

    if not isinstance(capabilities, dict):
        add_error(
            errors,
            "capabilities.type",
            "capabilities must be a mapping.",
            "Use an empty mapping ({}) or declare evidenced capabilities.",
        )
    else:
        for name, capability in capabilities.items():
            label = f"capabilities.{name}"
            if not isinstance(capability, dict):
                add_error(
                    errors,
                    "capability.type",
                    f"{label} must be a mapping.",
                    "Declare status and evidence fields.",
                )
                continue
            status = capability.get("status")
            if status not in ALLOWED_CAPABILITY_STATUSES:
                add_error(
                    errors,
                    "capability.status",
                    f"{label}.status is unsupported: {status!r}.",
                    f"Use one of {sorted(ALLOWED_CAPABILITY_STATUSES)}.",
                )
            evidence = capability.get("evidence", [])
            if status in EVIDENCE_REQUIRED_STATUSES and (
                not isinstance(evidence, list) or not evidence
            ):
                add_error(
                    errors,
                    "capability.evidence",
                    f"{label}.evidence is required when status is {status!r}.",
                    "Cite a reproducible path or 'command: ...' result, or lower the status.",
                )
            if isinstance(evidence, list):
                for item in evidence:
                    if not isinstance(item, str):
                        add_error(
                            errors,
                            "capability.evidence-type",
                            f"{label}.evidence entries must be strings.",
                            "Use repository paths or 'command: ...' entries.",
                        )
                        continue
                    if item.startswith("command: "):
                        validate_command(
                            root,
                            f"{label}.evidence",
                            item.removeprefix("command: "),
                            errors,
                            warnings,
                        )
                        continue
                    evidence_path = re.sub(r":\d+(?:-\d+)?$", "", item)
                    repository_path(root, evidence_path, f"{label}.evidence", errors)

    validate_knowledge_store(root, manifest, guidance, guidance_text, errors, warnings)

    policies = manifest.get("policies")
    if not isinstance(policies, list):
        add_error(
            errors,
            "policies.type",
            "policies must be a list.",
            "Use [] or declare policy mappings.",
        )
    else:
        for index, policy in enumerate(policies):
            label = f"policies[{index}]"
            if not isinstance(policy, dict):
                add_error(
                    errors,
                    "policy.type",
                    f"{label} must be a mapping.",
                    "Use id, enforcement, owner, and remediation fields.",
                )
                continue
            for field in ("id", "enforcement", "owner", "remediation"):
                if policy.get(field) in {None, "", "unknown"}:
                    add_error(
                        errors,
                        "policy.field",
                        f"{label}.{field} must be explicit.",
                        f"Name the policy {field}; remove aspirational policies that are not enforced.",
                    )
            if policy.get("enforcement") not in {None, "", "unknown"}:
                validate_command(
                    root,
                    f"{label}.enforcement",
                    policy["enforcement"],
                    errors,
                    warnings,
                )

    freshness = manifest.get("freshness")
    days = freshness.get("review_after_days") if isinstance(freshness, dict) else None
    if not isinstance(days, int) or days <= 0:
        add_error(
            errors,
            "freshness.review",
            "freshness.review_after_days must be a positive integer.",
            "Set a concrete review interval, such as 90.",
        )

    ledger = root / "docs" / "harness" / "learning-ledger.md"
    if not ledger.is_file():
        add_error(
            errors,
            "ledger.missing",
            "docs/harness/learning-ledger.md is absent.",
            "Add the bundled learning-ledger template.",
        )
    else:
        try:
            ledger_text = ledger.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            ledger_text = ""
        missing = [marker for marker in LEDGER_MARKERS if marker not in ledger_text]
        if missing:
            add_error(
                errors,
                "ledger.contract",
                f"learning ledger is missing fields: {', '.join(missing)}.",
                "Restore the shared learning-ledger entry contract.",
            )

    return errors, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("repository", nargs="?", default=".")
    args = parser.parse_args()
    root = Path(args.repository).expanduser().resolve()
    manifest_path = root / "docs" / "harness" / "manifest.yaml"
    if not root.is_dir():
        print(
            f"ERROR [repository.missing] repository is not a directory: {root}. Remediation: pass the repository root."
        )
        return 1
    try:
        text = manifest_path.read_text(encoding="utf-8")
    except OSError:
        print(
            "ERROR [manifest.missing] docs/harness/manifest.yaml is absent. Remediation: preview and add the minimum harness manifest."
        )
        return 1
    try:
        manifest = YamlSubsetParser(text).parse()
    except YamlSubsetError as parse_error:
        print(
            f"ERROR [manifest.yaml] {parse_error}. Remediation: use the bundled manifest template and the supported YAML subset."
        )
        return 1

    errors, warnings = validate_manifest(root, manifest)
    for warning in warnings:
        print(warning)
    for diagnostic in errors:
        print(diagnostic)
    if errors:
        print(
            f"FAIL: harness contract has {len(errors)} error(s) and {len(warnings)} warning(s)."
        )
        return 1
    print(
        f"PASS: harness contract is internally consistent ({len(warnings)} warning(s))."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
