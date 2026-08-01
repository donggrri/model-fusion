#!/usr/bin/env python3
"""Run configured read-only reviewers concurrently with one shared prompt."""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
from typing import Any


MAX_PROMPT_BYTES = 120_000
DEFAULT_AGENT_CONFIG = Path(__file__).resolve().parents[1] / "agents" / "availability.yaml"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Collect read-only opinions from reviewers available in the active environment."
    )
    parser.add_argument("--prompt-file", required=True, type=Path)
    parser.add_argument("--workspace", default=Path.cwd(), type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--timeout-seconds", default=300, type=int)
    parser.add_argument(
        "--agent-config",
        default=DEFAULT_AGENT_CONFIG,
        type=Path,
        help="Environment/agent availability YAML (default: repository agents/availability.yaml).",
    )
    parser.add_argument(
        "--environment",
        help="Override the active environment; otherwise MODEL_FUSION_ENV or the config default is used.",
    )
    parser.add_argument("--agy-bin", help="Override the configured AGY reviewer command.")
    parser.add_argument("--cursor-bin", help="Override the configured Cursor reviewer command.")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate inputs and show reviewer availability without invoking models.",
    )
    return parser.parse_args()


def extract_json(text: str) -> tuple[Any | None, str | None]:
    candidate = text.strip()
    if candidate.startswith("```") and candidate.endswith("```"):
        lines = candidate.splitlines()
        candidate = "\n".join(lines[1:-1]).strip()

    try:
        return json.loads(candidate), None
    except json.JSONDecodeError:
        pass

    start = candidate.find("{")
    if start < 0:
        return None, "response did not contain a JSON object"

    decoder = json.JSONDecoder()
    try:
        value, _ = decoder.raw_decode(candidate[start:])
        return value, None
    except json.JSONDecodeError as exc:
        return None, f"could not parse reviewer JSON: {exc}"


def schema_warnings(value: Any) -> list[str]:
    if not isinstance(value, dict):
        return ["top-level response must be a JSON object"]

    warnings: list[str] = []
    required = (
        "mode",
        "verdict",
        "findings",
        "alternatives",
        "risks",
        "verification",
        "assumptions",
        "unknowns",
    )
    for key in required:
        if key not in value:
            warnings.append(f"missing required field: {key}")

    verdict = value.get("verdict")
    if not isinstance(verdict, dict):
        warnings.append("verdict must be an object")
    else:
        for key in ("summary", "recommended_action", "confidence"):
            if key not in verdict:
                warnings.append(f"missing verdict field: {key}")
        confidence = verdict.get("confidence")
        if confidence is not None and (
            not isinstance(confidence, (int, float))
            or isinstance(confidence, bool)
            or not 0 <= confidence <= 100
        ):
            warnings.append("verdict.confidence must be a number from 0 to 100")

    for key in (
        "findings",
        "alternatives",
        "risks",
        "verification",
        "assumptions",
        "unknowns",
    ):
        if key in value and not isinstance(value[key], list):
            warnings.append(f"{key} must be an array")
    return warnings


class AgentConfigError(ValueError):
    """Raised when the environment/agent availability config is invalid."""


def load_agent_config(config_path: Path) -> dict[str, Any]:
    try:
        import yaml
    except ModuleNotFoundError as exc:
        raise AgentConfigError(
            "PyYAML is required to read agent availability config. "
            "Install it with: python -m pip install PyYAML"
        ) from exc

    path = config_path.resolve()
    if not path.is_file():
        raise AgentConfigError(f"Agent availability config not found: {path}")
    try:
        value = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise AgentConfigError(f"Could not parse agent availability config {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise AgentConfigError("Agent availability config must contain a YAML object")
    if value.get("schema_version") != 1:
        raise AgentConfigError("Unsupported or missing agent availability schema_version; expected 1")
    return value


def select_environment(
    config: dict[str, Any], requested_environment: str | None
) -> tuple[str, dict[str, Any]]:
    environments = config.get("environments")
    if not isinstance(environments, dict):
        raise AgentConfigError("Agent availability config must define an environments mapping")

    environment_name = (
        requested_environment
        or os.environ.get("MODEL_FUSION_ENV")
        or config.get("active_environment")
    )
    if not isinstance(environment_name, str) or not environment_name:
        raise AgentConfigError(
            "No active environment configured; set active_environment or MODEL_FUSION_ENV"
        )

    environment = environments.get(environment_name)
    if not isinstance(environment, dict):
        available = ", ".join(sorted(str(name) for name in environments))
        raise AgentConfigError(
            f"Unknown environment {environment_name!r}; available environments: {available}"
        )
    return environment_name, environment


def resolve_command(command: str) -> str | None:
    expanded = os.path.expandvars(os.path.expanduser(command))
    candidate = Path(expanded)
    if candidate.is_absolute():
        return str(candidate) if candidate.is_file() else None
    return shutil.which(expanded)


def build_reviewer_plan(
    environment: dict[str, Any],
    workspace: Path,
    prompt: str,
    timeout_seconds: int,
    command_overrides: dict[str, str | None],
) -> tuple[dict[str, dict[str, Any]], dict[str, list[str]]]:
    agents = environment.get("agents")
    if not isinstance(agents, dict):
        raise AgentConfigError("Active environment must define an agents mapping")

    states: dict[str, dict[str, Any]] = {}
    commands: dict[str, list[str]] = {}
    for name, raw_spec in agents.items():
        if not isinstance(name, str) or not isinstance(raw_spec, dict):
            raise AgentConfigError("Each agent entry must have a name and mapping")

        capabilities = raw_spec.get("capabilities", [])
        if not isinstance(capabilities, list) or not all(
            isinstance(capability, str) for capability in capabilities
        ):
            raise AgentConfigError(f"Agent {name!r} capabilities must be a list of strings")

        base_state: dict[str, Any] = {
            "configured": True,
            "capabilities": capabilities,
            "model": raw_spec.get("model"),
        }
        if "review" not in capabilities:
            states[name] = {
                **base_state,
                "status": "not_selected",
                "reason": "agent does not advertise review capability",
            }
            continue
        if raw_spec.get("available") is not True:
            states[name] = {
                **base_state,
                "status": "disabled",
                "reason": raw_spec.get("reason", "agent is disabled for this environment"),
            }
            continue

        review = raw_spec.get("review")
        if not isinstance(review, dict):
            raise AgentConfigError(f"Available reviewer {name!r} must define a review mapping")
        configured_command = review.get("command")
        if not isinstance(configured_command, str) or not configured_command:
            raise AgentConfigError(f"Available reviewer {name!r} must define review.command")
        command = command_overrides.get(name) or configured_command
        resolved = resolve_command(command)
        state = {**base_state, "command": command, "path": resolved}
        if resolved is None:
            states[name] = {
                **state,
                "status": "unavailable",
                "reason": f"command was not found: {command}",
            }
            continue

        raw_args = review.get("args")
        if not isinstance(raw_args, list) or not all(
            isinstance(argument, str) for argument in raw_args
        ):
            raise AgentConfigError(
                f"Available reviewer {name!r} must define review.args as a list of strings"
            )
        if not any("{prompt}" in argument for argument in raw_args):
            raise AgentConfigError(
                f"Available reviewer {name!r} review.args must include the {{prompt}} placeholder"
            )

        replacements = {
            "{workspace}": str(workspace),
            "{prompt}": prompt,
            "{timeout}": str(timeout_seconds),
            "{model}": str(raw_spec.get("model", "")),
        }
        rendered_args: list[str] = []
        for raw_argument in raw_args:
            rendered = raw_argument
            for token, replacement in replacements.items():
                rendered = rendered.replace(token, replacement)
            rendered_args.append(rendered)
        states[name] = {**state, "status": "ready"}
        commands[name] = [resolved, *rendered_args]

    return states, commands


def git_state(workspace: Path) -> str | None:
    try:
        result = subprocess.run(
            ["git", "status", "--porcelain=v1", "-z", "--untracked-files=all"],
            cwd=workspace,
            check=False,
            capture_output=True,
            timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    return hashlib.sha256(result.stdout).hexdigest()


def invoke(
    name: str,
    command: list[str],
    workspace: Path,
    timeout_seconds: int,
    env: dict[str, str],
) -> dict[str, Any]:
    started = time.monotonic()
    try:
        result = subprocess.run(
            command,
            cwd=workspace,
            env=env,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout_seconds + 30,
        )
    except subprocess.TimeoutExpired as exc:
        return {
            "status": "timeout",
            "duration_ms": round((time.monotonic() - started) * 1000),
            "error": f"{name} exceeded {timeout_seconds + 30} seconds",
            "stdout": exc.stdout or "",
            "stderr": exc.stderr or "",
        }
    except OSError as exc:
        return {
            "status": "error",
            "duration_ms": round((time.monotonic() - started) * 1000),
            "error": str(exc),
        }

    duration_ms = round((time.monotonic() - started) * 1000)
    parsed, parse_error = extract_json(result.stdout)
    response: dict[str, Any] = {
        "status": "ok" if result.returncode == 0 else "error",
        "return_code": result.returncode,
        "duration_ms": duration_ms,
        "stderr": result.stderr.strip(),
    }
    if parsed is not None:
        response["response"] = parsed
        warnings = schema_warnings(parsed)
        if warnings:
            response["schema_warnings"] = warnings
    else:
        response["raw_response"] = result.stdout.strip()
        response["parse_error"] = parse_error
    if result.returncode != 0:
        response["error"] = f"{name} exited with status {result.returncode}"
    return response


def main() -> int:
    args = parse_args()
    prompt_path = args.prompt_file.resolve()
    workspace = args.workspace.resolve()
    output_path = args.output.resolve()

    if not prompt_path.is_file():
        print(f"Prompt file not found: {prompt_path}", file=sys.stderr)
        return 2
    if not workspace.is_dir():
        print(f"Workspace directory not found: {workspace}", file=sys.stderr)
        return 2
    if args.timeout_seconds < 1:
        print("--timeout-seconds must be positive", file=sys.stderr)
        return 2

    prompt_bytes = prompt_path.read_bytes()
    if len(prompt_bytes) > MAX_PROMPT_BYTES:
        print(
            f"Prompt is {len(prompt_bytes)} bytes; maximum is {MAX_PROMPT_BYTES}",
            file=sys.stderr,
        )
        return 2
    try:
        prompt = prompt_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        print(f"Prompt must be UTF-8: {exc}", file=sys.stderr)
        return 2

    try:
        agent_config = load_agent_config(args.agent_config)
        environment_name, environment = select_environment(
            agent_config, args.environment
        )
        reviewer_states, commands = build_reviewer_plan(
            environment,
            workspace,
            prompt,
            args.timeout_seconds,
            {"agy": args.agy_bin, "cursor": args.cursor_bin},
        )
    except AgentConfigError as exc:
        print(str(exc), file=sys.stderr)
        return 2

    prompt_sha256 = hashlib.sha256(prompt_bytes).hexdigest()

    if args.dry_run:
        print(
            json.dumps(
                {
                    "prompt_sha256": prompt_sha256,
                    "prompt_bytes": len(prompt_bytes),
                    "workspace": str(workspace),
                    "agent_config": str(args.agent_config.resolve()),
                    "environment": environment_name,
                    "reviewers": reviewer_states,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0 if commands else 1

    before_state = git_state(workspace)
    env = os.environ.copy()
    env["AGY_CLI_DISABLE_AUTO_UPDATE"] = "true"
    reviewers: dict[str, Any] = {
        name: state
        for name, state in reviewer_states.items()
        if state.get("status") != "ready"
    }

    with concurrent.futures.ThreadPoolExecutor(
        max_workers=max(1, min(8, len(commands)))
    ) as executor:
        future_map = {
            executor.submit(
                invoke,
                name,
                command,
                workspace,
                args.timeout_seconds,
                env,
            ): name
            for name, command in commands.items()
        }
        for future in concurrent.futures.as_completed(future_map):
            name = future_map[future]
            reviewers[name] = {**reviewer_states[name], **future.result()}

    after_state = git_state(workspace)
    workspace_changed = (
        before_state is not None
        and after_state is not None
        and before_state != after_state
    )
    payload = {
        "schema_version": "1.0",
        "prompt_sha256": prompt_sha256,
        "prompt_bytes": len(prompt_bytes),
        "workspace": str(workspace),
        "agent_config": str(args.agent_config.resolve()),
        "environment": environment_name,
        "workspace_changed_during_review": workspace_changed,
        "reviewers": reviewers,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(output_path)

    completed = sum(
        reviewer.get("status") == "ok" for reviewer in reviewers.values()
    )
    return 0 if completed > 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
