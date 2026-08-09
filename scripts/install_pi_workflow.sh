#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"

PI_BIN="${PI_BIN:-pi}"
AGENT_DIR="${PI_CODING_AGENT_DIR:-${HOME:-}/.pi/agent}"
SOURCE_FILE="${PI_WORKFLOW_SOURCE:-${REPO_ROOT}/pi-workflow/index.ts}"
CURSOR_PACKAGE="${PI_WORKFLOW_CURSOR_PACKAGE:-npm:@rahularya01/pi-cursor}"
AGY_BIN="${PI_AGY_BIN:-agy}"

skip_cursor=0
dry_run=0
agent_dir_explicit=0

usage() {
	cat <<'EOF'
Install the Pi workflow extension for Linux/WSL.

Usage:
  scripts/install_pi_workflow.sh [options]

Options:
  --agent-dir PATH    Pi agent directory (default: $PI_CODING_AGENT_DIR or ~/.pi/agent)
  --source PATH       Extension source file (default: this repo's pi-workflow/index.ts)
  --skip-cursor       Do not install the Cursor provider package
  --dry-run           Show the installation plan without changing files
  -h, --help          Show this help

Environment:
  PI_BIN                      Pi executable (default: pi)
  PI_CODING_AGENT_DIR         Pi agent directory
  PI_WORKFLOW_SOURCE          Extension source override
  PI_WORKFLOW_CURSOR_PACKAGE  Cursor provider package (default: npm:@rahularya01/pi-cursor)
  PI_AGY_BIN                  AGY executable used by the extension (default: agy)
  PI_WORKFLOW_SKIP_CURSOR=1   Same as --skip-cursor
EOF
}

die() {
	echo "[pi-workflow] error: $*" >&2
	exit 1
}

info() {
	echo "[pi-workflow] $*"
}

warn() {
	echo "[pi-workflow] warning: $*" >&2
}

require_linux() {
	case "$(uname -s)" in
		Linux*) ;;
		*) die "This installer targets Linux/WSL. Detected: $(uname -s)" ;;
	esac
}

command_exists() {
	command -v "$1" >/dev/null 2>&1
}

agy_available() {
	if [[ "${AGY_BIN}" == */* ]]; then
		[[ -x "${AGY_BIN}" ]]
	else
		command_exists "${AGY_BIN}"
	fi
}

while (($# > 0)); do
	case "$1" in
		--agent-dir)
			(($# >= 2)) || die "--agent-dir requires a path"
			AGENT_DIR="$2"
			agent_dir_explicit=1
			shift 2
			;;
		--source)
			(($# >= 2)) || die "--source requires a path"
			SOURCE_FILE="$2"
			shift 2
			;;
		--skip-cursor)
			skip_cursor=1
			shift
			;;
		--dry-run)
			dry_run=1
			shift
			;;
		-h|--help)
			usage
			exit 0
			;;
		*)
			die "Unknown option: $1 (use --help)"
			;;
	esac
done

if [[ "${PI_WORKFLOW_SKIP_CURSOR:-0}" == "1" ]]; then
	skip_cursor=1
fi

require_linux
if [[ -z "${HOME:-}" && "${agent_dir_explicit}" -eq 0 ]]; then
	die "HOME is not set; pass --agent-dir explicitly"
fi
[[ -f "${SOURCE_FILE}" ]] || die "Extension source not found: ${SOURCE_FILE}"

TARGET_DIR="${AGENT_DIR}/extensions/pi-workflow"
TARGET_FILE="${TARGET_DIR}/index.ts"

if ((dry_run)); then
	info "source: ${SOURCE_FILE}"
	info "target: ${TARGET_FILE}"
	if ((skip_cursor)); then
		info "Cursor provider installation: skipped"
	else
		info "Cursor provider: ${CURSOR_PACKAGE}"
	fi
	info "AGY executable expected by the extension: ${AGY_BIN}"
	exit 0
fi

command_exists "${PI_BIN}" || die "Pi executable not found: ${PI_BIN}. Install Pi or set PI_BIN."

export PI_CODING_AGENT_DIR="${AGENT_DIR}"
mkdir -p "${TARGET_DIR}"

if [[ -f "${TARGET_FILE}" ]] && ! cmp -s "${SOURCE_FILE}" "${TARGET_FILE}"; then
	backup_file="${TARGET_FILE}.bak.$(date -u +%Y%m%dT%H%M%SZ)"
	cp -p "${TARGET_FILE}" "${backup_file}"
	info "Backed up the existing extension to ${backup_file}"
fi

install -m 0644 "${SOURCE_FILE}" "${TARGET_FILE}"
info "Installed extension: ${TARGET_FILE}"

if ((skip_cursor)); then
	info "Skipped Cursor provider installation"
else
	info "Installing Cursor provider: ${CURSOR_PACKAGE}"
	"${PI_BIN}" install "${CURSOR_PACKAGE}"
fi

if agy_available; then
	info "AGY executable found: ${AGY_BIN}"
else
	warn "AGY executable not found: ${AGY_BIN}. Set PI_AGY_BIN before using mode=agy."
fi

cat <<EOF

Pi workflow installation complete.
Agent directory: ${AGENT_DIR}
Extension:       ${TARGET_FILE}

Restart Pi or run /reload, then use:
  /workflow plan <task>
  /workflow review <task>
  /workflow agy <task>
  /workflow-status
EOF
