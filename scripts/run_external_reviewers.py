#!/usr/bin/env python3
"""Run AGY and Cursor Agent concurrently with the exact same read-only prompt."""

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


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Collect read-only AGY and Cursor opinions for Codex synthesis."
    )
    parser.add_argument("--prompt-file", required=True, type=Path)
    parser.add_argument("--workspace", default=Path.cwd(), type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--timeout-seconds", default=300, type=int)
    parser.add_argument("--agy-bin", default="agy")
    parser.add_argument("--cursor-bin", default="cursor-agent")
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

    resolved = {
        "agy": shutil.which(args.agy_bin),
        "cursor": shutil.which(args.cursor_bin),
    }
    prompt_sha256 = hashlib.sha256(prompt_bytes).hexdigest()

    if args.dry_run:
        print(
            json.dumps(
                {
                    "prompt_sha256": prompt_sha256,
                    "prompt_bytes": len(prompt_bytes),
                    "workspace": str(workspace),
                    "reviewers": {
                        key: {"available": value is not None, "path": value}
                        for key, value in resolved.items()
                    },
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0 if all(resolved.values()) else 1

    commands: dict[str, list[str]] = {}
    if resolved["agy"]:
        commands["agy"] = [
            resolved["agy"],
            "--print",
            "--mode=plan",
            "--sandbox",
            "--print-timeout",
            f"{args.timeout_seconds}s",
            prompt,
        ]
    if resolved["cursor"]:
        commands["cursor"] = [
            resolved["cursor"],
            "-p",
            "--mode=plan",
            "--sandbox",
            "enabled",
            "--output-format",
            "text",
            "--workspace",
            str(workspace),
            prompt,
        ]

    before_state = git_state(workspace)
    env = os.environ.copy()
    env["AGY_CLI_DISABLE_AUTO_UPDATE"] = "true"
    reviewers: dict[str, Any] = {}
    missing = [name for name, path in resolved.items() if path is None]
    for name in missing:
        reviewers[name] = {
            "status": "unavailable",
            "error": f"{name} CLI was not found on PATH",
        }

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
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
            reviewers[future_map[future]] = future.result()

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
