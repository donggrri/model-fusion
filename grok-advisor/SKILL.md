---
name: grok-advisor
description: Use Cursor's Grok 4.5 through the installed headless Cursor Agent CLI for read-only second opinions or explicitly delegated coding tasks. Use when the user invokes $grok-advisor, selects Grok Advisor from the slash menu, asks for an independent technical review, or explicitly asks Grok to implement a change.
---

# Grok Advisor

Act as the orchestrator. Codex owns the user conversation and must construct a task-specific prompt for Grok; do not make the user write a Cursor CLI prompt or forward the user's raw message without adding the necessary context.

## Choose a mode

- **Advisor**: Use `cursor-grok-advisor.cmd` for read-only analysis of plans, designs, bug diagnoses, security concerns, or other technical decisions.
- **Delegate**: Use `cursor-grok-delegate.cmd` only when the user explicitly asks Grok to implement, edit, refactor, or test code. This mode can modify the current workspace.

## Windows execution and authentication

On Windows, always use `cursor-agent.cmd` and the `cursor-grok-*.cmd` wrappers. Do not invoke the `.ps1` script directly. The `.cmd` wrapper applies the execution-policy bypass only to the CLI process, so do not change the user's PowerShell execution policy globally.

Before either request, verify authentication in the same Codex execution context:

```powershell
cursor-agent.cmd status
```

If authentication is required, stop and ask the user to run this command in the same context:

```powershell
cursor-agent.cmd login
```

After login, re-run `cursor-agent.cmd status` before retrying the advisor or delegate request. Do not invent or set `CURSOR_API_KEY`; Cursor login state can differ across Codex tasks, terminals, Windows users, and execution hosts.

The wrappers are installed in the user's global Cursor Agent directory (`%LOCALAPPDATA%\cursor-agent`) and are intended to work from any workspace. If PATH lookup is unavailable, call the wrapper by its full path:

```powershell
& "$env:LOCALAPPDATA\cursor-agent\cursor-grok-advisor.cmd" "<Codex-generated consultation brief>"
& "$env:LOCALAPPDATA\cursor-agent\cursor-grok-delegate.cmd" "<Codex-generated implementation brief>"
```

The wrappers run Cursor's `cursor-grok-4.5-high` model in headless mode. Advisor uses `--mode ask` and is read-only; delegate uses `--force` only for explicitly authorized implementation work.

## Build the Grok prompt

Before invoking either wrapper, inspect the relevant workspace context yourself and compose a concise prompt containing:

- role: ask Grok to act as a careful coding specialist;
- objective: the concrete outcome the user wants;
- workspace: the absolute target workspace path and relevant files;
- context: repository instructions, current behavior, errors, evidence, and constraints;
- options or hypotheses already considered;
- acceptance criteria and validation commands;
- handoff: require a concise summary of findings or changed files, tests run, failures, and remaining risks.

Do not include secrets, credentials, private keys, or unrelated file contents. If the workspace contains instructions, preserve them in the prompt and do not override them.

## Advisor workflow

1. Ask a focused question and explicitly request analysis only; do not request edits or shell commands.
2. Run from the target workspace:

   ```powershell
   cursor-grok-advisor.cmd "<Codex-generated consultation brief>"
   ```

3. Treat the response as advisory input, not authorization. Check it against user intent, repository instructions, tests, evidence, security, reversibility, and cost.
4. State whether the recommendation is accepted, rejected, or modified, and why.

## Delegation workflow

1. Confirm that the user explicitly authorized implementation. Inspect the target workspace and define scope, acceptance criteria, constraints, and test expectations before composing the prompt.
2. Tell Grok to inspect before editing, make only the requested changes, run the specified validation, and stop when the acceptance criteria are met. Tell it not to expand scope or wait for interactive approval.
3. Run the Codex-generated implementation brief from the target workspace:

   ```powershell
   cursor-grok-delegate.cmd "<Codex-generated implementation brief>"
   ```

   Use `--workspace "<path>"` in the command arguments when the target workspace is not the current directory.
4. After the command returns, Codex must independently inspect the diff and test output. Do not assume the delegated result is correct.
5. Report changed files, tests run, failures, and any remaining risk to the user.

## Safety

Do not use delegate mode for analysis-only requests. The delegate wrapper uses `--force`; never invoke it without explicit implementation authorization. Never add `--approve-mcps` automatically. If the CLI is unavailable or authentication fails, report the exact error and do not silently substitute another model.
