# Pi Three-Lane Workflow Extension

Pi-native extension for plan / build / review / AGY lanes and optional multi-model fusion.

Installs into:

- Linux / WSL: `~/.pi/agent/extensions/pi-three-lane-workflow/`
- Windows: `%USERPROFILE%\.pi\agent\extensions\pi-three-lane-workflow\`

## Prerequisites

- [Pi](https://github.com/earendil-works/pi-coding-agent) (`pi` on `PATH`)
- For Cursor models: Cursor provider package (installed by the scripts below unless `--skip-cursor`)
- For `mode=agy`: `agy` on `PATH` (optional; Windows also supports `%LOCALAPPDATA%\\agy\\bin\\agy.exe`)

## Install

### Linux / WSL

From the repository root:

```bash
scripts/install_pi_workflow.sh
```

Dry run:

```bash
scripts/install_pi_workflow.sh --dry-run
```

### Windows

From the repository root in `cmd.exe` or PowerShell:

```cmd
scripts\install-pi-workflow.cmd
```

Dry run:

```cmd
scripts\install-pi-workflow.cmd --dry-run
```

## Common options

Both installers support:

| Option | Description |
|--------|-------------|
| `--agent-dir PATH` | Override Pi agent directory |
| `--source-dir PATH` | Override extension source directory |
| `--skip-cursor` | Skip `pi install` for the Cursor provider |
| `--dry-run` | Print the install plan only |
| `-h`, `--help` | Show help |

Environment variables:

| Variable | Default |
|----------|---------|
| `PI_BIN` | `pi` |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` or `%USERPROFILE%\.pi\agent` |
| `PI_WORKFLOW_SOURCE_DIR` | this repo's `pi-workflow/` |
| `PI_WORKFLOW_CURSOR_PACKAGE` | `npm:@rahularya01/pi-cursor` |
| `PI_AGY_BIN` | `agy` |
| `PI_WORKFLOW_SKIP_CURSOR` | `1` skips Cursor install |

## After install

Restart Pi or run `/reload`, then:

```
/workflow plan <task>
/workflow build <task>
/workflow review <task>
/workflow agy <task>
/workflow-status
```

Fusion (read-only, 2–3 models) is available via `/workflow` flags or the `run_workflow` tool.

## What gets installed

All top-level `*.ts` files from `pi-workflow/` are copied into the Pi extension directory. Existing files with different content are backed up as `*.bak.<timestamp>` before overwrite.
