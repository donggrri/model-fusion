#!/usr/bin/env python3
"""Validate the repository and its configured agent environment."""

from __future__ import annotations

import argparse
import importlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from typing import Any

try:
    from environment_selection import resolve_environment_name
except ImportError:  # pragma: no cover - supports package-style imports in tests
    from scripts.environment_selection import resolve_environment_name


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = ROOT / "agents" / "availability.yaml"
FRONTMATTER = re.compile(
    r"\A---\r?\nname:\s*(?P<name>[^\r\n]+)\r?\ndescription:\s*(?P<description>.+?)\r?\n---",
    re.DOTALL,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Validate model-fusion repository setup and agent availability."
    )
    parser.add_argument("--agent-config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--environment")
    parser.add_argument(
        "--install-pyyaml",
        action="store_true",
        help="Install PyYAML into the Python interpreter running this command if missing.",
    )
    parser.add_argument("--json", action="store_true", help="Print a machine-readable report.")
    return parser.parse_args()


def import_yaml(install: bool) -> tuple[Any | None, str | None]:
    try:
        return importlib.import_module("yaml"), None
    except ModuleNotFoundError:
        if not install:
            return None, "PyYAML is missing; rerun with --install-pyyaml."

    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "PyYAML"],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip()
        return None, f"PyYAML installation failed: {detail}"
    try:
        return importlib.import_module("yaml"), None
    except ModuleNotFoundError:
        return None, "PyYAML installation completed but the module is still unavailable."


def expand_command(command: str) -> str:
    return os.path.expandvars(os.path.expanduser(command))


def resolve_command(command: str) -> str | None:
    expanded = expand_command(command)
    candidate = Path(expanded)
    if candidate.is_absolute():
        return str(candidate) if candidate.is_file() else None
    return shutil.which(expanded)


def check_skills(root: Path) -> tuple[list[dict[str, Any]], list[str]]:
    checks: list[dict[str, Any]] = []
    errors: list[str] = []
    for skill_path in sorted(root.rglob("SKILL.md")):
        if ".git" in skill_path.parts or "__pycache__" in skill_path.parts:
            continue
        match = FRONTMATTER.match(skill_path.read_text(encoding="utf-8"))
        expected_name = root.name if skill_path.parent == root else skill_path.parent.name
        valid = bool(
            match
            and match.group("name").strip() == expected_name
            and match.group("description").strip()
        )
        line_count = len(skill_path.read_text(encoding="utf-8").splitlines())
        if line_count >= 500:
            valid = False
            errors.append(f"Skill exceeds 500 lines: {skill_path}")
        if not valid:
            errors.append(f"Invalid skill frontmatter: {skill_path}")
        checks.append(
            {
                "path": str(skill_path.relative_to(root)),
                "valid": valid,
                "lines": line_count,
            }
        )
    if not checks:
        errors.append("No SKILL.md files found")
    return checks, errors


def load_config(
    config_path: Path, yaml_module: Any, requested_environment: str | None
) -> tuple[str | None, dict[str, Any] | None, list[str]]:
    errors: list[str] = []
    path = config_path.resolve()
    if not path.is_file():
        return None, None, [f"Agent config not found: {path}"]
    try:
        config = yaml_module.safe_load(path.read_text(encoding="utf-8"))
    except yaml_module.YAMLError as exc:
        return None, None, [f"Invalid agent config YAML: {exc}"]
    if not isinstance(config, dict) or config.get("schema_version") != 1:
        return None, None, ["Agent config must be a mapping with schema_version: 1"]

    environments = config.get("environments")
    if not isinstance(environments, dict):
        return None, None, ["Agent config must define environments"]
    try:
        environment_name = resolve_environment_name(config, requested_environment)
    except ValueError as exc:
        return None, None, [str(exc)]
    environment = environments.get(environment_name)
    if not isinstance(environment_name, str) or not isinstance(environment, dict):
        available = ", ".join(sorted(str(name) for name in environments))
        return None, None, [f"Unknown active environment {environment_name!r}; available: {available}"]
    return environment_name, environment, errors


def check_agents(environment: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    agents = environment.get("agents")
    if not isinstance(agents, dict):
        return {}, ["Active environment must define agents"]

    report: dict[str, Any] = {}
    errors: list[str] = []
    for name, spec in agents.items():
        if not isinstance(spec, dict):
            errors.append(f"Agent {name!r} must be a mapping")
            continue
        capabilities = spec.get("capabilities", [])
        available = spec.get("available") is True
        state: dict[str, Any] = {
            "available": available,
            "capabilities": capabilities,
            "model": spec.get("model"),
        }
        if not available:
            state["status"] = "disabled"
            state["reason"] = spec.get("reason", "agent is disabled")
            report[str(name)] = state
            continue

        resolved: dict[str, str | None] = {}
        for capability in capabilities if isinstance(capabilities, list) else []:
            operation = spec.get(capability)
            if not isinstance(operation, dict):
                errors.append(f"Available agent {name!r} lacks {capability}.command")
                continue
            command = operation.get("command")
            if not isinstance(command, str) or not command:
                errors.append(f"Available agent {name!r} has invalid {capability}.command")
                continue
            resolved[capability] = resolve_command(command)
            if resolved[capability] is None:
                errors.append(f"Configured command not found for {name}/{capability}: {command}")

        preflight = spec.get("preflight")
        if isinstance(preflight, dict):
            status_command = preflight.get("status")
            if isinstance(status_command, list) and status_command:
                executable = status_command[0]
                if isinstance(executable, str) and resolve_command(executable) is None:
                    errors.append(f"Preflight command not found for {name}: {executable}")

        state["status"] = "ready" if not any(
            error.startswith(f"Available agent {name!r}")
            or error.startswith(f"Configured command not found for {name}/")
            or error.startswith(f"Preflight command not found for {name}:")
            for error in errors
        ) else "error"
        state["commands"] = resolved
        report[str(name)] = state
    return report, errors


def main() -> int:
    args = parse_args()
    errors: list[str] = []
    warnings: list[str] = []
    checks: dict[str, Any] = {
        "repository": str(ROOT),
        "python": sys.executable,
        "agents_file": (ROOT / "AGENTS.md").is_file(),
    }
    if not checks["agents_file"]:
        errors.append(f"Missing repository instructions: {ROOT / 'AGENTS.md'}")

    skill_checks, skill_errors = check_skills(ROOT)
    checks["skills"] = skill_checks
    errors.extend(skill_errors)

    yaml_module, yaml_error = import_yaml(args.install_pyyaml)
    if yaml_module is None:
        checks["pyyaml"] = {"available": False}
        errors.append(yaml_error or "PyYAML is unavailable")
        environment_name = None
        agent_report: dict[str, Any] = {}
    else:
        checks["pyyaml"] = {
            "available": True,
            "version": getattr(yaml_module, "__version__", "unknown"),
        }
        environment_name, environment, config_errors = load_config(
            args.agent_config, yaml_module, args.environment
        )
        errors.extend(config_errors)
        agent_report = {}
        if environment is not None:
            agent_report, agent_errors = check_agents(environment)
            errors.extend(agent_errors)

    checks["environment"] = environment_name
    checks["agents"] = agent_report
    checks["config"] = str(args.agent_config.resolve())
    report = {"ok": not errors, "checks": checks, "warnings": warnings, "errors": errors}

    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print("model-fusion setup")
        print(f"Repository: {ROOT}")
        print(f"AGENTS.md: {'found' if checks['agents_file'] else 'missing'}")
        print(f"Environment: {environment_name or 'unresolved'}")
        pyyaml = checks["pyyaml"]
        print(f"PyYAML: {pyyaml.get('version', 'missing')}")
        for name, state in agent_report.items():
            capabilities = ", ".join(state.get("capabilities", []))
            print(f"Agent {name}: {state.get('status')} ({capabilities})")
            if state.get("reason"):
                print(f"  reason: {state['reason']}")
            for capability, command in state.get("commands", {}).items():
                print(f"  {capability}: {command or 'missing'}")
        if errors:
            print("\nSetup failed:")
            for error in errors:
                print(f"- {error}")
        else:
            print("\nSetup checks passed. Review AGENTS.md before delegating work.")

    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
