#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd -P)"

PI_BIN="${PI_BIN:-pi}"
AGENT_DIR="${PI_CODING_AGENT_DIR:-${HOME:-}/.pi/agent}"
SOURCE_DIR="${PI_WORKFLOW_SOURCE_DIR:-${REPO_ROOT}/pi-workflow}"
CURSOR_PACKAGE="${PI_WORKFLOW_CURSOR_PACKAGE:-npm:@rahularya01/pi-cursor}"
AGY_BIN="${PI_AGY_BIN:-agy}"

skip_cursor=0
dry_run=0
agent_dir_explicit=0

die() { echo "error: $*" >&2; exit 1; }
info() { echo "$*"; }
warn() { echo "warning: $*" >&2; }
command_exists() { command -v "$1" >/dev/null 2>&1; }
agy_available() { command_exists "${AGY_BIN}"; }
require_linux() {
	case "$(uname -s 2>/dev/null || true)" in
		Linux*) ;;
		*) die "This installer targets Linux/WSL. On Windows, run scripts\\install-pi-workflow.cmd" ;;
	esac
}

usage() {
	cat <<'USAGE'
Install the Pi three-lane workflow extension for Linux/WSL.
On Windows, use scripts/install-pi-workflow.cmd instead.

Usage:
  scripts/install_pi_workflow.sh [options]

Options:
  --agent-dir PATH     Pi agent directory (default: $PI_CODING_AGENT_DIR or ~/.pi/agent)
  --source-dir PATH    Extension source directory (default: this repo's pi-workflow/)
  --skip-cursor        Do not install the Cursor provider package
  --dry-run            Show the installation plan without changing files
  -h, --help           Show this help

Environment:
  PI_BIN                      Pi executable (default: pi)
  PI_CODING_AGENT_DIR         Pi agent directory
  PI_WORKFLOW_SOURCE_DIR      Extension source directory override
  PI_WORKFLOW_CURSOR_PACKAGE  Cursor provider package (default: npm:@rahularya01/pi-cursor)
  PI_AGY_BIN                  AGY executable used by the extension (default: agy)
  PI_WORKFLOW_SKIP_CURSOR=1   Same as --skip-cursor
USAGE
}

while (($# > 0)); do
	case "$1" in
		--agent-dir)
			(($# >= 2)) || die "--agent-dir requires a path"
			AGENT_DIR="$2"
			agent_dir_explicit=1
			shift 2
			;;
		--source-dir|--source)
			(($# >= 2)) || die "--source-dir requires a path"
			SOURCE_DIR="$2"
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
[[ -d "${SOURCE_DIR}" ]] || die "Extension source directory not found: ${SOURCE_DIR}"
[[ -f "${SOURCE_DIR}/index.ts" ]] || die "Extension entrypoint not found: ${SOURCE_DIR}/index.ts"

TARGET_DIR="${AGENT_DIR}/extensions/pi-three-lane-workflow"

if ((dry_run)); then
	info "source: ${SOURCE_DIR}"
	info "target: ${TARGET_DIR}"
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

shopt -s nullglob
mapfile -t source_files < <(find "${SOURCE_DIR}" -maxdepth 1 -type f -name '*.ts' | sort)
((${#source_files[@]} > 0)) || die "No .ts files found in ${SOURCE_DIR}"

for source_file in "${source_files[@]}"; do
	base="$(basename -- "${source_file}")"
	target_file="${TARGET_DIR}/${base}"
	if [[ -f "${target_file}" ]] && ! cmp -s "${source_file}" "${target_file}"; then
		backup_file="${target_file}.bak.$(date -u +%Y%m%dT%H%M%SZ)"
		cp -p "${target_file}" "${backup_file}"
		info "Backed up ${base} to ${backup_file}"
	fi
	install -m 0644 "${source_file}" "${target_file}"
	info "Installed ${base}"
done

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

cat <<EOM

Pi workflow installation complete.
Agent directory: ${AGENT_DIR}
Extension:       ${TARGET_DIR}

Restart Pi or run /reload, then use:
  /workflow plan <task>
  /workflow review <task>
  /workflow agy <task>
  /workflow-status
EOM
