#!/usr/bin/env bash
# verify-audit.sh — runtime verification for the 2026-05-25 audit fixes
#
# Complements pnpm test by exercising behaviours the test suite can't easily
# capture: actual exit codes from the binary, real file-system permissions
# on the config file, and grep-able patterns in dashboard output.
#
# Usage:
#   ./scripts/verify-audit.sh            # run every check
#   ./scripts/verify-audit.sh --quick    # skip slow checks (full fit run)
#   ./scripts/verify-audit.sh --no-build # assume packages/cli/dist is current
#
# Exits 0 if every check passes; 1 if any check fails. Each check prints a
# PASS/FAIL line so a failed run shows exactly what broke.

set -u
set -o pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

QUICK=0
SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=1 ;;
    --no-build) SKIP_BUILD=1 ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

PASS=0
FAIL=0
FAILURES=()

pass() {
  PASS=$((PASS + 1))
  printf '  \033[32m✓\033[0m %s\n' "$1"
}

fail() {
  FAIL=$((FAIL + 1))
  FAILURES+=("$1")
  printf '  \033[31m✗\033[0m %s\n' "$1"
  if [[ -n "${2-}" ]]; then
    printf '      %s\n' "$2"
  fi
}

section() {
  printf '\n\033[1m%s\033[0m\n' "$1"
}

CLI="node packages/cli/dist/index.js"
TMPDIR_VERIFY="$(mktemp -d -t opensip-verify-XXXXXX)"
trap 'rm -rf "$TMPDIR_VERIFY"' EXIT

# ---------------------------------------------------------------------------
# 0. Build (skippable)
# ---------------------------------------------------------------------------
if [[ $SKIP_BUILD -eq 0 ]]; then
  section "Build"
  if pnpm build >"$TMPDIR_VERIFY/build.log" 2>&1; then
    pass "pnpm build clean"
  else
    fail "pnpm build failed" "see $TMPDIR_VERIFY/build.log"
    printf 'Aborting — build must succeed before runtime checks.\n' >&2
    exit 1
  fi
fi

if [[ ! -f packages/cli/dist/index.js ]]; then
  printf 'packages/cli/dist/index.js missing — run without --no-build.\n' >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 1. Exit-code routing (contracts/exit-codes.ts audit fix)
# ---------------------------------------------------------------------------
section "Exit-code routing"

# Recipe-not-found must now route to CONFIGURATION_ERROR (2), not
# CHECK_NOT_FOUND (3). Build a minimal scratch project so fit doesn't fail
# on missing config.
SCRATCH="$TMPDIR_VERIFY/scratch"
mkdir -p "$SCRATCH"
$CLI init --cwd "$SCRATCH" --language typescript >/dev/null 2>&1 || true

set +e
$CLI fit --cwd "$SCRATCH" --recipe definitely-not-a-real-recipe >"$TMPDIR_VERIFY/recipe-err.log" 2>&1
RECIPE_EXIT=$?
set -e

if [[ $RECIPE_EXIT -eq 2 ]]; then
  pass "fit --recipe <unknown> → exit 2 (CONFIGURATION_ERROR)"
else
  fail "fit --recipe <unknown> exit code" "got $RECIPE_EXIT, expected 2 (CONFIGURATION_ERROR). Log: $TMPDIR_VERIFY/recipe-err.log"
fi

# init --cwd /nonexistent must exit 2 (was silently 0 before the fix).
set +e
$CLI init --cwd "$TMPDIR_VERIFY/definitely-not-a-real-directory" --language typescript >"$TMPDIR_VERIFY/cwd-err.log" 2>&1
CWD_EXIT=$?
set -e

if [[ $CWD_EXIT -ne 0 ]]; then
  pass "init --cwd <nonexistent> → non-zero exit"
else
  fail "init --cwd <nonexistent> exit code" "got 0 (expected non-zero). Log: $TMPDIR_VERIFY/cwd-err.log"
fi

# ---------------------------------------------------------------------------
# 2. Config file mode (cli/global-config.ts audit fix)
# ---------------------------------------------------------------------------
section "API key file permissions"

CONFIG_FILE="$HOME/.opensip-tools/config.yml"
PREEXISTING_CONFIG=""
if [[ -f "$CONFIG_FILE" ]]; then
  PREEXISTING_CONFIG="$(cat "$CONFIG_FILE")"
fi

# Use the API to drive writeGlobalConfig. We invoke a tiny Node script
# against the built cli package so we exercise the actual code path.
node -e "
  const { writeGlobalConfig } = require('./packages/cli/dist/bootstrap/global-config.js');
  writeGlobalConfig({ apiKey: 'sk-verify-script-test' });
" 2>"$TMPDIR_VERIFY/writeconfig.log"

if [[ -f "$CONFIG_FILE" ]]; then
  # macOS: %Lp, Linux: %a — use stat -c on Linux, stat -f on macOS.
  if stat -c '%a' "$CONFIG_FILE" >/dev/null 2>&1; then
    MODE="$(stat -c '%a' "$CONFIG_FILE")"
  else
    MODE="$(stat -f '%Lp' "$CONFIG_FILE")"
  fi
  if [[ "$MODE" == "600" ]]; then
    pass "~/.opensip-tools/config.yml mode is 0600"
  else
    fail "~/.opensip-tools/config.yml mode" "got $MODE, expected 600"
  fi
else
  fail "writeGlobalConfig did not create the config file" "see $TMPDIR_VERIFY/writeconfig.log"
fi

# Confirm no temp files leaked in the same directory.
STRAGGLERS="$(find "$HOME/.opensip-tools" -maxdepth 1 -name '*.tmp' 2>/dev/null | wc -l | tr -d ' ')"
if [[ "$STRAGGLERS" == "0" ]]; then
  pass "no .tmp stragglers left in ~/.opensip-tools/"
else
  fail "temp files leaked" "$STRAGGLERS *.tmp file(s) found in ~/.opensip-tools/"
fi

# Restore prior config (if any) so we don't trash the user's setup.
if [[ -n "$PREEXISTING_CONFIG" ]]; then
  printf '%s' "$PREEXISTING_CONFIG" >"$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"
fi

# ---------------------------------------------------------------------------
# 3. Dashboard escape (dashboard/generator.ts audit fix)
# ---------------------------------------------------------------------------
section "Dashboard XSS escape"

DASH_HTML="$TMPDIR_VERIFY/dash.html"
node -e "
  const { generateDashboardHtml } = require('./packages/dashboard/dist/generator.js');
  process.stdout.write(generateDashboardHtml({
    sessions: [],
    editorProtocol: '</script><img src=x onerror=alert(1)>',
  }));
" >"$DASH_HTML" 2>"$TMPDIR_VERIFY/dash.log" || true

if [[ -s "$DASH_HTML" ]]; then
  # The raw </script> sequence must NOT appear inside the EDITOR_PROTOCOL line.
  EDITOR_LINE="$(grep -n '^const EDITOR_PROTOCOL = ' "$DASH_HTML" || true)"
  if [[ -z "$EDITOR_LINE" ]]; then
    fail "editorProtocol constant not found in dashboard output"
  else
    # Strip the line number prefix that grep -n adds.
    EDITOR_BODY="${EDITOR_LINE#*:}"
    if printf '%s' "$EDITOR_BODY" | grep -q '</script>'; then
      fail "editorProtocol literal contains raw </script>" "line: $EDITOR_BODY"
    else
      pass "editorProtocol literal escapes </script>"
    fi
    if printf '%s' "$EDITOR_BODY" | grep -q '\\u003c'; then
      pass "editorProtocol literal contains \\u003c escape"
    else
      fail "editorProtocol literal missing \\u003c escape" "line: $EDITOR_BODY"
    fi
  fi
else
  fail "dashboard HTML was empty" "see $TMPDIR_VERIFY/dash.log"
fi

# ---------------------------------------------------------------------------
# 4. Sessions hydration (contracts/session-repo.ts audit fix)
# ---------------------------------------------------------------------------
section "Sessions hydration"

# The contracts layer now validates row.tool / row.summary at hydration time.
# We can confirm the happy path by running fit twice (populates the store)
# then listing sessions as JSON and checking the shape.
if [[ $QUICK -eq 0 ]]; then
  FIT_OUT="$TMPDIR_VERIFY/fit.log"
  if $CLI fit >"$FIT_OUT" 2>&1; then
    pass "fit run against this repo succeeded"
  else
    if [[ $? -eq 1 ]]; then
      pass "fit ran (exit 1 = checks failed but engine is healthy)"
    else
      fail "fit run failed unexpectedly" "see $FIT_OUT"
    fi
  fi

  LIST_OUT="$TMPDIR_VERIFY/sessions.json"
  if $CLI sessions list --json >"$LIST_OUT" 2>&1; then
    # Each session must have a valid tool union member and a complete summary.
    if node -e "
      const raw = JSON.parse(require('fs').readFileSync('$LIST_OUT', 'utf8'));
      // The CLI wraps the array in { type: 'history', sessions: [...] }.
      const data = Array.isArray(raw) ? raw : (raw.sessions ?? []);
      const validTools = new Set(['fit', 'sim', 'graph']);
      const summaryFields = ['total', 'passed', 'failed', 'errors', 'warnings'];
      for (const s of data) {
        if (!validTools.has(s.tool)) {
          console.error('Invalid tool:', s.tool);
          process.exit(1);
        }
        for (const f of summaryFields) {
          if (typeof s.summary?.[f] !== 'number') {
            console.error('Missing summary field on session ' + s.id + ':', f);
            process.exit(1);
          }
        }
      }
    " 2>"$TMPDIR_VERIFY/hydrate.log"; then
      pass "hydrated sessions all carry valid tool + summary shape"
    else
      fail "hydrated session shape" "see $TMPDIR_VERIFY/hydrate.log"
    fi
  else
    fail "sessions list --json failed" "see $LIST_OUT"
  fi
else
  printf '  (skipped — pass without --quick to run)\n'
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
section "Summary"
printf '  Passed: \033[32m%d\033[0m\n' "$PASS"
printf '  Failed: \033[31m%d\033[0m\n' "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  printf '\nFailed checks:\n'
  for f in "${FAILURES[@]}"; do
    printf '  - %s\n' "$f"
  done
  exit 1
fi

exit 0
