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
#   curl -fsSL https://opensip.ai/cli/install.sh | OPENSIP_CLI_VERSION=1.0.0 bash

PACKAGE_NAME="${OPENSIP_CLI_PACKAGE:-opensip-cli}"
PACKAGE_VERSION="${OPENSIP_CLI_VERSION:-latest}"
INSTALL_SPEC="${PACKAGE_NAME}@${PACKAGE_VERSION}"
MIN_NODE_MAJOR=24
SMOKE_DIR=""
ACTIVE_CHILD_PID=""
STEP_MARKER="==>"
SUCCESS_MARKER="🎉"

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
  printf '%s\n' "${BOLD}${STEP_MARKER}${RESET} ${DIM}$1${RESET}"
}

ok() {
  printf '%s\n' "${GREEN}${STEP_MARKER}${RESET} $1"
}

warn() {
  printf '%s\n' "${YELLOW}${STEP_MARKER}${RESET} $1"
}

error() {
  printf '%s\n' "${RED}Error:${RESET} $1" >&2
}

clear_progress_line() {
  if [ -t 1 ]; then
    printf '\r\033[K'
  fi
}

run_with_spinner() {
  label="$1"
  shift
  : >"$LOG_FILE"

  if [ -t 1 ]; then
    "$@" >"$LOG_FILE" 2>&1 &
    ACTIVE_CHILD_PID="$!"
    frame=0

    while kill -0 "$ACTIVE_CHILD_PID" >/dev/null 2>&1; do
      case "$frame" in
        0) dots="   " ;;
        1) dots=".  " ;;
        2) dots=".. " ;;
        *) dots="..." ;;
      esac
      printf '\r%s%s%s %s%s%s%s' "$BOLD" "$STEP_MARKER" "$RESET" "$DIM" "$label" "$dots" "$RESET"
      frame=$(((frame + 1) % 4))
      sleep 0.2
    done

    set +e
    wait "$ACTIVE_CHILD_PID"
    status="$?"
    set -e
    ACTIVE_CHILD_PID=""
    clear_progress_line
    return "$status"
  fi

  info "$label..."
  set +e
  "$@" >"$LOG_FILE" 2>&1
  status="$?"
  set -e
  return "$status"
}

# Public re-run line + install options shown when Node/npm is missing or below the floor.
INSTALL_RERUN='curl -fsSL https://opensip.ai/cli/install.sh | bash'
DOCS_URL='https://opensip.ai/docs/opensip-cli'

print_node_install_help() {
  printf '\n%s\n' "Install or switch to Node.js ${MIN_NODE_MAJOR}+, then re-run:" >&2
  printf '  %s\n' "$INSTALL_RERUN" >&2
  printf '\n%s\n' "Common options:" >&2
  printf '  %s\n' "nvm:   nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}" >&2
  printf '  %s\n' "fnm:   fnm install ${MIN_NODE_MAJOR} && fnm use ${MIN_NODE_MAJOR}" >&2
  printf '  %s\n' "brew:  brew install node@${MIN_NODE_MAJOR}" >&2
  printf '  %s\n' "Other: https://nodejs.org/en/download" >&2
  printf '\n%s\n' "Docs: ${DOCS_URL}" >&2
}

# Strip a leading v/V and surrounding whitespace so "v0.6.0" and "0.6.0" compare equal.
normalize_version() {
  printf '%s' "$1" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s/^[vV]//'
}

# Resolve the opensip binary: PATH first, then npm's global bin (may not be on PATH yet).
resolve_opensip_cmd() {
  if command -v opensip >/dev/null 2>&1; then
    command -v opensip
    return 0
  fi
  prefix="$(npm prefix -g 2>/dev/null || true)"
  if [ -n "$prefix" ] && [ -x "${prefix%/}/bin/opensip" ]; then
    printf '%s\n' "${prefix%/}/bin/opensip"
    return 0
  fi
  return 1
}

# Best-effort version of a currently installed opensip binary (empty if missing/unreadable).
read_opensip_version() {
  cmd="$1"
  if [ -z "$cmd" ] || [ ! -x "$cmd" ]; then
    return 0
  fi
  "$cmd" --version 2>/dev/null || true
}

if ! command -v node >/dev/null 2>&1; then
  error "Node.js was not found on PATH."
  printf '\n%s\n' "OpenSIP CLI needs Node.js ${MIN_NODE_MAJOR}+ (with npm)." >&2
  print_node_install_help
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  error "npm was not found on PATH."
  printf '\n%s\n' "OpenSIP CLI needs Node.js ${MIN_NODE_MAJOR}+ with npm." >&2
  NODE_PATH="$(command -v node 2>/dev/null || true)"
  if [ -n "$NODE_PATH" ]; then
    printf '\n%s\n' "  Found node at: ${NODE_PATH}" >&2
  fi
  print_node_install_help
  exit 1
fi

NODE_PATH="$(command -v node)"
NODE_VERSION="$(node --version 2>/dev/null | sed 's/^v//')"
NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | sed 's/\..*$//')"

case "$NODE_MAJOR" in
  ''|*[!0-9]*)
    error "Could not read your Node.js version."
    printf '\n%s\n' "OpenSIP CLI requires Node.js ${MIN_NODE_MAJOR}+." >&2
    printf '\n%s\n' "  Found:   ${NODE_PATH}" >&2
    print_node_install_help
    exit 1
    ;;
esac

if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  error "OpenSIP CLI requires Node.js ${MIN_NODE_MAJOR}+."
  printf '\n%s\n' "  Found:   v${NODE_VERSION}  at ${NODE_PATH}" >&2
  printf '%s\n' "  Need:    Node.js ${MIN_NODE_MAJOR}+" >&2
  printf '\n%s\n' "If you already installed a newer Node, check which one is first on PATH:" >&2
  printf '  %s\n' "which -a node" >&2
  printf '  %s\n' "node --version" >&2
  print_node_install_help
  exit 1
fi

LOG_FILE="$(mktemp -t opensip-cli-install.XXXXXX)"
cleanup() {
  if [ -n "$ACTIVE_CHILD_PID" ]; then
    kill "$ACTIVE_CHILD_PID" >/dev/null 2>&1 || true
    ACTIVE_CHILD_PID=""
    clear_progress_line
  fi
  rm -f "$LOG_FILE"
  if [ -n "$SMOKE_DIR" ]; then
    rm -rf "$SMOKE_DIR"
  fi
}
trap cleanup EXIT
trap 'cleanup; exit 1' INT TERM

# Snapshot any pre-existing install so the post-install line can say "updated
# from A to B" instead of a bare "is installed" when this run is an upgrade.
PREVIOUS_VERSION=""
if PREVIOUS_OPEN_CMD="$(resolve_opensip_cmd)"; then
  PREVIOUS_VERSION="$(read_opensip_version "$PREVIOUS_OPEN_CMD")"
fi

# `npm install -g` both fetches the package tree from the registry and links it
# into the global prefix. On a cold cache the wall-clock is dominated by download
# (opensip-cli pulls ~hundreds of packages); install/link is the tail. There is no
# clean public npm split of those phases without a second full install, so the
# progress label names both rather than claiming only "Installing".
if ! run_with_spinner "Downloading and installing ${INSTALL_SPEC}" npm install -g "$INSTALL_SPEC" --loglevel=error --no-audit --no-fund; then
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
if OPEN_CMD="$(resolve_opensip_cmd)"; then
  :
else
  OPEN_CMD=""
fi

if [ -n "$OPEN_CMD" ]; then
  INSTALLED_VERSION="$(read_opensip_version "$OPEN_CMD")"
  PREV_NORM="$(normalize_version "$PREVIOUS_VERSION")"
  NEW_NORM="$(normalize_version "$INSTALLED_VERSION")"
  if [ -n "$PREV_NORM" ] && [ -n "$NEW_NORM" ] && [ "$PREV_NORM" != "$NEW_NORM" ]; then
    ok "Updated opensip from v${PREV_NORM} to v${NEW_NORM}."
  elif [ -n "$INSTALLED_VERSION" ]; then
    ok "opensip ${INSTALLED_VERSION} is installed."
  else
    ok "opensip is installed."
  fi

  if [ "${OPENSIP_CLI_SKIP_SMOKE:-}" != "1" ]; then
    SMOKE_DIR="$(mktemp -d -t opensip-cli-smoke.XXXXXX)"
    if ! run_with_spinner "Verifying the CLI runs" "$OPEN_CMD" init --cwd "$SMOKE_DIR" --language typescript --json; then
      error "Install verification failed while scaffolding a temporary project."
      if [ -s "$LOG_FILE" ]; then
        printf '\n%s\n' "opensip output:" >&2
        cat "$LOG_FILE" >&2
      fi
      printf '\n%s\n' "You can skip this check with OPENSIP_CLI_SKIP_SMOKE=1, but the CLI may not be usable until this is resolved." >&2
      exit 1
    fi
    # The single-quoted string is the BODY passed to `sh -c`; $1/$2 are
    # positional params expanded by THAT inner shell (supplied by the trailing
    # `sh "$SMOKE_DIR" "$OPEN_CMD"`), not here — so single quotes are correct.
    # shellcheck disable=SC2016
    if ! run_with_spinner "Verifying the data store opens" sh -c 'cd "$1" && "$2" sessions list --json' sh "$SMOKE_DIR" "$OPEN_CMD"; then
      error "Install verification failed while opening the SQLite data store."
      if [ -s "$LOG_FILE" ]; then
        printf '\n%s\n' "opensip output:" >&2
        cat "$LOG_FILE" >&2
      fi
      printf '\n%s\n' "Verify Node.js ${MIN_NODE_MAJOR}+ is first on PATH, then retry the installer." >&2
      exit 1
    fi
    rm -rf "$SMOKE_DIR"
    SMOKE_DIR=""
    ok "Verified: the CLI runs and its data store opens."
  else
    warn "Skipping install verification because OPENSIP_CLI_SKIP_SMOKE=1."
  fi
else
  ok "opensip is installed."
  if [ -n "$GLOBAL_BIN" ]; then
    warn "The npm global bin directory is not on PATH: ${GLOBAL_BIN}"
    printf '%s\n' "Add it to PATH or restart your shell before running opensip."
  fi
fi

# Final banner. The version step line above already says "installed", so this
# line claims the stronger, verified state instead of repeating it — except in
# the PATH-warning branch, where "ready" would not be true yet.
if [ -n "$OPEN_CMD" ]; then
  printf '\n%s\n' "${SUCCESS_MARKER} OpenSIP CLI is ready."
else
  printf '\n%s\n' "${SUCCESS_MARKER} OpenSIP CLI installed. Restart your shell before running the commands below."
fi

printf '\n%s\n' "Next steps (run in your project):"
printf '  %s\n' "${BOLD}opensip audit${RESET}          ${DIM}# review your changed code before you commit${RESET}"
printf '  %s\n' "${BOLD}opensip audit --full${RESET}   ${DIM}# or review the whole repo right now${RESET}"
printf '  %s\n' "${BOLD}opensip init${RESET}           ${DIM}# optional: customize what gets checked${RESET}"
printf '\n%s\n' "${DIM}Docs: https://opensip.ai/docs/opensip-cli${RESET}"
