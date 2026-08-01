---
name: delegate
description: Select and apply the repository's relevant Codex skills, build a task-specific brief, and delegate explicitly authorized implementation work to the globally installed Cursor Agent wrapper. Use when the user invokes $delegate or asks Cursor Agent to implement, edit, refactor, fix, or test code using this repository's skills.
---

# Delegate

Act as the orchestration layer for implementation delegation. Codex owns the conversation, selects the relevant repository skills, defines the scope, and verifies the result. The selected agent performs the explicitly authorized coding work.

## Invocation boundary

- Run this workflow only after the user invokes `$delegate`, selects Delegate from the skill menu, or clearly asks to delegate implementation work to Cursor Agent.
- Do not delegate analysis-only requests. Use `$grok-advisor` for a read-only second opinion or handle the analysis in Codex.
- Treat commit, push, deployment, destructive operations, secret handling, and external messages as separate authorizations. Do not include them in the delegated scope unless the user explicitly requests them.
- Never select `delegate` itself as a repository skill. Do not ask Cursor Agent to invoke Codex skills recursively.

## Workflow

### 1. Inspect the target workspace

Before composing the delegation brief, inspect the absolute current workspace, `AGENTS.md`, repository instructions, relevant files, current behavior, errors, tests, and the working-tree status. Preserve user changes and do not reset or discard them.

Discover repository skills with:

```powershell
rg --files -g 'SKILL.md'
```

Treat the root `SKILL.md` and each nested skill directory as candidates. Read metadata first, then read the body of skills that match the task or define a required repository workflow. Do not load unrelated skills just to create the appearance of consensus.

### 2. Select and apply skills

Build a small skill map for the task:

- select skills whose descriptions or workflows directly cover the requested work;
- add supporting skills when they provide required validation, domain rules, security constraints, or tool-specific procedures;
- record the concrete instructions extracted from each selected skill;
- resolve conflicts using user requirements first, repository instructions second, and safety/reversibility constraints third;
- omit skills that are unrelated, obsolete, or recursive.

Apply the selected skills to the workflow, not just to the prompt label. Convert their actionable rules into constraints, implementation guidance, acceptance criteria, and validation steps for the selected agent. If no repository skill is relevant, say so in the brief and continue with repository instructions and normal engineering practice.

### Parallel role planning

When the task benefits from multiple perspectives, split the work into explicit roles such as `explorer`, `tester`, `reviewer`, and one `implementer`:

- run independent exploration, tests, and review in parallel when they are read-only or isolated;
- allow only one writer in the target checkout at a time;
- use separate Git worktrees and branches for competing implementations, then let Codex compare and integrate them;
- require every role to return findings, changed files, checks, failures, and risks before Codex decides the next step.

Do not create parallel work merely to increase agent count. Keep the selected role set proportional to the task and the agents available in the active environment.

### 3. Resolve the available delegate agent

Read the shared [agent availability config](../agents/availability.yaml) before choosing a delegate target. Resolve the environment in this order:

1. An explicit environment choice in the task.
2. The `MODEL_FUSION_ENV` environment variable.
3. `active_environment` in the config.

Select only an agent with `available: true` and the `delegate` capability. Use that agent's configured `delegate.command`, `model`, and `preflight` entries in the brief and execution. In the checked-in `windows-cursor` environment, this selects Cursor's `cursor-grok-delegate.cmd`; AGY is not a valid delegate target. If no eligible agent is available, stop and report the exact configuration or command gap instead of silently switching agents.

### 4. Run the configured preflight

Run the selected agent's configured preflight status command in the same Codex execution context. For the current Cursor target, this is:

```powershell
cursor-agent.cmd status
```

If authentication is required, stop and ask the user to run the configured login command. For the current Cursor target, this is:

```powershell
cursor-agent.cmd login
```

After login, re-run the configured status command. Do not invent or set `CURSOR_API_KEY`; login state can differ across Codex tasks, terminals, Windows users, and execution hosts. If the configured wrapper or CLI is unavailable, report the exact error and do not silently substitute another model or tool.

### 5. Build the delegation brief

Construct the prompt yourself; do not forward the user's raw message. Include:

- role: careful coding specialist working inside the target workspace;
- objective: the concrete outcome and why it matters;
- workspace: absolute path and relevant files or directories;
- selected environment and delegate agent, including the configured model and capability;
- selected skills: names plus the actionable constraints being applied;
- repository rules, current behavior, evidence, errors, and hypotheses;
- exact scope and explicitly excluded work;
- acceptance criteria and validation commands;
- handoff: changed files, tests run, failures, unresolved risks, and remaining decisions.

Tell the selected agent to inspect before editing, make only the requested changes, avoid unrelated refactors, run the stated validation, and stop when the acceptance criteria are met. Exclude secrets, credentials, private keys, unrelated file contents, and hidden reasoning from the prompt.

### 6. Delegate implementation

Run the selected agent's configured `delegate.command` from the target workspace. In the current `windows-cursor` environment:

```powershell
cursor-grok-delegate.cmd "<Codex-generated implementation brief>"
```

If PATH lookup is unavailable, use the globally installed wrapper:

```powershell
& "$env:LOCALAPPDATA\cursor-agent\cursor-grok-delegate.cmd" "<Codex-generated implementation brief>"
```

The configured Cursor wrapper uses `cursor-grok-4.5-high` in headless mode with write authorization. Never add `--approve-mcps` automatically. Use `--workspace "<path>"` when the target workspace is not the current directory and the installed CLI supports that argument.

### 7. Independently verify the handoff

After the command returns, inspect the result yourself:

1. Read the wrapper output and preserve partial results on failure or timeout.
2. Inspect `git status`, the diff, changed-file scope, and any generated artifacts.
3. Run or inspect the acceptance tests and relevant static checks.
4. Confirm that selected skill constraints were followed and that no unauthorized operation occurred.
5. If the result is incomplete, report the exact gap and remaining risk; do not silently broaden scope or discard the delegate's changes.

## Report format

Return a concise handoff containing:

- selected repository skills and how each influenced the workflow;
- delegated outcome and changed files;
- tests and validation performed, including failures;
- remaining risks, blocked items, and the next concrete action.

## Example

```text
$delegate
Implement the requested feature in this repository, select any relevant local skills, write tests, and run the validation commands. Do not commit or push.
```
