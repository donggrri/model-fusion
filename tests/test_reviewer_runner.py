from __future__ import annotations

import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from scripts import environment_selection
from scripts import run_external_reviewers as runner


VALID_REVIEW = json.dumps(
    {
        "mode": "review",
        "verdict": {
            "summary": "The change is safe.",
            "recommended_action": "Keep it.",
            "confidence": 80,
        },
        "findings": [],
        "alternatives": [],
        "risks": [],
        "verification": [],
        "assumptions": [],
        "unknowns": [],
    }
)


class EnvironmentSelectionTests(unittest.TestCase):
    def test_selects_linux_mapping_without_changing_legacy_default(self) -> None:
        config = {
            "active_environment": "windows-cursor",
            "platform_environments": {
                "windows": "windows-cursor",
                "linux": "linux-cursor",
            },
        }

        self.assertEqual(
            environment_selection.resolve_environment_name(config, platform_name="Linux"),
            "linux-cursor",
        )
        self.assertEqual(
            environment_selection.resolve_environment_name(config, platform_name="Windows"),
            "windows-cursor",
        )

    def test_explicit_environment_wins_over_platform_mapping(self) -> None:
        config = {
            "active_environment": "windows-cursor",
            "platform_environments": {"linux": "linux-cursor"},
        }

        self.assertEqual(
            environment_selection.resolve_environment_name(
                config, "windows-cursor", platform_name="Linux"
            ),
            "windows-cursor",
        )


class ReviewerRunnerTests(unittest.TestCase):
    def test_checked_in_agy_configs_use_prompt_valued_print_flag(self) -> None:
        config = runner.load_agent_config(
            Path(__file__).resolve().parents[1] / "agents" / "availability.yaml"
        )

        for environment_name in ("windows-cursor", "linux-cursor"):
            args = config["environments"][environment_name]["agents"]["agy"]["review"]["args"]
            print_index = args.index("--print")
            self.assertEqual(args[print_index + 1], "{prompt}")
            self.assertIn("--sandbox", args)
            self.assertIn("--dangerously-skip-permissions", args)

    def test_agy_print_receives_prompt_as_print_value(self) -> None:
        prompt = "Return JSON."
        environment = {
            "agents": {
                "agy": {
                    "available": True,
                    "capabilities": ["review"],
                    "model": "test-model",
                    "review": {
                        "command": sys.executable,
                        "args": ["--print", "{prompt}", "--mode", "plan"],
                    },
                }
            }
        }

        _, commands = runner.build_reviewer_plan(
            environment,
            Path.cwd(),
            prompt,
            30,
            {},
        )

        command = commands["agy"]
        self.assertEqual(command[1:4], ["--print", prompt, "--mode"])

    def test_headless_permission_denial_is_not_false_green(self) -> None:
        denial = (
            'jetski: no output produced — a tool required the "command" permission '
            "that headless mode cannot prompt for, so it was auto-denied."
        )
        with patch.object(
            runner.subprocess,
            "run",
            return_value=runner.subprocess.CompletedProcess(["agy"], 0, denial, ""),
        ) as run:
            result = runner.invoke("agy", ["agy"], Path.cwd(), 1, {})

        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error_kind"], "headless_permission_denied")
        self.assertIs(run.call_args.kwargs["stdin"], runner.subprocess.DEVNULL)

    def test_valid_json_with_zero_exit_is_ok(self) -> None:
        with patch.object(
            runner.subprocess,
            "run",
            return_value=runner.subprocess.CompletedProcess(["reviewer"], 0, VALID_REVIEW, ""),
        ):
            result = runner.invoke("reviewer", ["reviewer"], Path.cwd(), 1, {})

        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["response"]["mode"], "review")

    def test_zero_exit_without_json_is_an_error(self) -> None:
        with patch.object(
            runner.subprocess,
            "run",
            return_value=runner.subprocess.CompletedProcess(["reviewer"], 0, "not json", ""),
        ):
            result = runner.invoke("reviewer", ["reviewer"], Path.cwd(), 1, {})

        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error_kind"], "invalid_reviewer_response")

    def test_json_missing_contract_fields_is_an_error(self) -> None:
        with patch.object(
            runner.subprocess,
            "run",
            return_value=runner.subprocess.CompletedProcess(
                ["reviewer"], 0, '{"mode":"review"}', ""
            ),
        ):
            result = runner.invoke("reviewer", ["reviewer"], Path.cwd(), 1, {})

        self.assertEqual(result["status"], "error")
        self.assertEqual(result["error_kind"], "invalid_reviewer_response")
        self.assertTrue(
            any(warning.startswith("missing required field") for warning in result["schema_warnings"])
        )

    def test_windows_prompt_limit_is_below_process_command_line_limit(self) -> None:
        self.assertEqual(runner.prompt_limit_for_platform("Windows"), 24_000)
        self.assertEqual(runner.prompt_limit_for_platform("Linux"), runner.MAX_PROMPT_BYTES)

    def test_timeout_normalizes_bytes_output(self) -> None:
        with patch.object(
            runner.subprocess,
            "run",
            side_effect=runner.subprocess.TimeoutExpired(
                ["reviewer"], 31, output=b"partial", stderr=b"blocked"
            ),
        ):
            result = runner.invoke("reviewer", ["reviewer"], Path.cwd(), 1, {})

        self.assertEqual(result["status"], "timeout")
        self.assertEqual(result["stdout"], "partial")
        self.assertEqual(result["stderr"], "blocked")


if __name__ == "__main__":
    unittest.main()
