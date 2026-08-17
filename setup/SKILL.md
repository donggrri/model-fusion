---
name: setup
description: Validate a freshly cloned model-fusion repository, its AGENTS.md instructions, PyYAML dependency, skill metadata, environment configuration, and available agent commands. Use after cloning, when switching environments, or when delegate/fusion reports setup or agent availability problems.
---

# Setup

Use this skill as the first-run and environment-change preflight for this repository. It validates the checked-in instructions and agent configuration without installing, logging in to, updating, or invoking external agents unless the user explicitly requests a separate action.

## Run the setup check

Run from the repository root:

```powershell
python scripts/setup_environment.py
```

On Windows, the convenience wrapper is:

```powershell
scripts\setup-environment.cmd
```

If PyYAML is missing and the user authorizes installing the repository's validation dependency, run:

```powershell
python scripts/setup_environment.py --install-pyyaml
```

If the environment has no usable `python` command, use its Python 3 executable explicitly or set `MODEL_FUSION_PYTHON` to that path. In the Codex desktop runtime this may be the bundled Python path returned by `load_workspace_dependencies`.

## What the check validates

The command checks:

- the repository root and [AGENTS.md](../AGENTS.md);
- every skill's frontmatter and basic size limits;
- `agents/availability.yaml` and the selected environment;
- PyYAML availability for the environment-aware reviewer runner;
- commands configured for each available agent capability;
- disabled agents and their reasons, without treating them as failures.

It reports the active environment, available capabilities, resolved command paths, and the next preflight command. It does not run `status`, `login`, `cursor-grok-advisor.cmd`, or `cursor-grok-delegate.cmd`; run those only after reviewing the report and explicitly authorizing the action.

## Environment selection

Use `--environment <name>` for a one-time override or set `MODEL_FUSION_ENV` for the current shell. Otherwise, the runner selects the configured platform mapping (`windows-cursor` on Windows and `linux-cursor` on Linux), falling back to `active_environment` from [agents/availability.yaml](../agents/availability.yaml). After changing the environment or agent config, rerun setup before using `$delegate` or `$model-fusion`.

## Failure handling

- Missing `AGENTS.md`, invalid skill metadata, invalid YAML, missing PyYAML, or a missing command for an enabled capability are setup failures.
- A disabled or unavailable optional agent is reported as unavailable and does not fail setup by itself.
- Do not make setup silently install external CLIs, change PowerShell execution policy, create credentials, or log in. Report the exact next command instead.
