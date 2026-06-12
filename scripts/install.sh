#!/usr/bin/env sh
set -eu

# OpenSIP CLI installer.
#
# Canonical source:
#   https://github.com/opensip-ai/opensip-cli/blob/main/scripts/install.sh
#
# Intended website command:
#   curl -fsSL https://opensip.ai/cli/install.sh | bash
#
# Optional:
#   curl -fsSL https://opensip.ai/cli/install.sh | OPENSIP_CLI_VERSION=3.0.0 bash

PACKAGE_NAME="${OPENSIP_CLI_PACKAGE:-opensip-cli}"
PACKAGE_VERSION="${OPENSIP_CLI_VERSION:-latest}"
INSTALL_SPEC="${PACKAGE_NAME}@${PACKAGE_VERSION}"
MIN_NODE_MAJOR=24
SMOKE_DIR=""

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  BOLD="$(printf '\033[1m')"
  GREEN="$(printf '\033[32m')"
  YELLOW="$(printf '\033[33m')"
  RED="$(printf '\033[31m')"
  DIM="$(printf '\033[2m')"
  RESET="$(printf '\033[0m')"
else
  BOLD=""
  GREEN=""
  YELLOW=""
  RED=""
  DIM=""
  RESET=""
fi

info() {
  printf '%s\n' "${BOLD}OpenSIP CLI${RESET}: ${DIM}$1${RESET}"
}

ok() {
  printf '%s\n' "${GREEN}Success:${RESET} $1"
}

warn() {
  printf '%s\n' "${YELLOW}Note:${RESET} $1"
}

error() {
  printf '%s\n' "${RED}Error:${RESET} $1" >&2
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    error "$2"
    exit 1
  fi
}

require_command node "Node.js is required. Install Node.js ${MIN_NODE_MAJOR}+ and run this installer again."
require_command npm "npm is required. Install Node.js ${MIN_NODE_MAJOR}+ with npm and run this installer again."

NODE_VERSION="$(node --version 2>/dev/null | sed 's/^v//')"
NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | sed 's/\..*$//')"

case "$NODE_MAJOR" in
  ''|*[!0-9]*)
    error "Could not read your Node.js version. Install Node.js ${MIN_NODE_MAJOR}+ and try again."
    exit 1
    ;;
esac

if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  error "OpenSIP CLI requires Node.js ${MIN_NODE_MAJOR}+; found Node.js ${NODE_VERSION}."
  printf '%s\n' "Update Node.js, then run this installer again." >&2
  exit 1
fi

info "Installing ${INSTALL_SPEC}..."

LOG_FILE="$(mktemp -t opensip-cli-install.XXXXXX)"
cleanup() {
  rm -f "$LOG_FILE"
  if [ -n "$SMOKE_DIR" ]; then
    rm -rf "$SMOKE_DIR"
  fi
}
trap cleanup EXIT
trap 'cleanup; exit 1' INT TERM

if ! npm install -g "$INSTALL_SPEC" --loglevel=error --no-audit --no-fund >"$LOG_FILE" 2>&1; then
  error "Install failed."
  if [ -s "$LOG_FILE" ]; then
    printf '\n%s\n' "npm output:" >&2
    cat "$LOG_FILE" >&2
  fi
  printf '\n%s\n' "You can retry manually with:" >&2
  printf '  npm install -g %s\n' "$INSTALL_SPEC" >&2
  exit 1
fi

GLOBAL_PREFIX="$(npm prefix -g 2>/dev/null || true)"
GLOBAL_BIN=""
if [ -n "$GLOBAL_PREFIX" ]; then
  GLOBAL_BIN="${GLOBAL_PREFIX%/}/bin"
fi

OPEN_CMD=""
if command -v opensip >/dev/null 2>&1; then
  OPEN_CMD="$(command -v opensip)"
elif [ -n "$GLOBAL_BIN" ] && [ -x "${GLOBAL_BIN%/}/opensip" ]; then
  OPEN_CMD="${GLOBAL_BIN%/}/opensip"
fi

if [ -n "$OPEN_CMD" ]; then
  INSTALLED_VERSION="$("$OPEN_CMD" --version 2>/dev/null || true)"
  if [ -n "$INSTALLED_VERSION" ]; then
    ok "opensip ${INSTALLED_VERSION} is installed."
  else
    ok "opensip is installed."
  fi

  if [ "${OPENSIP_CLI_SKIP_SMOKE:-}" != "1" ]; then
    info "Running install smoke test..."
    SMOKE_DIR="$(mktemp -d -t opensip-cli-smoke.XXXXXX)"
    if ! "$OPEN_CMD" init --cwd "$SMOKE_DIR" --language typescript --json >"$LOG_FILE" 2>&1; then
      error "Smoke test failed while scaffolding a temporary project."
      if [ -s "$LOG_FILE" ]; then
        printf '\n%s\n' "opensip output:" >&2
        cat "$LOG_FILE" >&2
      fi
      printf '\n%s\n' "You can skip the smoke test with OPENSIP_CLI_SKIP_SMOKE=1, but the CLI may not be usable until this is resolved." >&2
      exit 1
    fi
    if ! (cd "$SMOKE_DIR" && "$OPEN_CMD" sessions list --json >"$LOG_FILE" 2>&1); then
      error "Smoke test failed while opening the SQLite data store."
      if [ -s "$LOG_FILE" ]; then
        printf '\n%s\n' "opensip output:" >&2
        cat "$LOG_FILE" >&2
      fi
      printf '\n%s\n' "Verify Node.js ${MIN_NODE_MAJOR}+ is first on PATH, then retry the installer." >&2
      exit 1
    fi
    rm -rf "$SMOKE_DIR"
    SMOKE_DIR=""
    ok "Install smoke test passed."
  else
    warn "Skipping install smoke test because OPENSIP_CLI_SKIP_SMOKE=1."
  fi
else
  ok "opensip is installed."
  if [ -n "$GLOBAL_BIN" ]; then
    warn "The npm global bin directory is not on PATH: ${GLOBAL_BIN}"
    printf '%s\n' "Add it to PATH or restart your shell before running opensip."
  fi
fi

printf '%s\n' "Run ${BOLD}opensip init${RESET} in your project to get started."
