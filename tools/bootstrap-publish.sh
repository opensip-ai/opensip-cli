#!/usr/bin/env bash
#
# One-time bootstrap publish for @opensip-tools/*.
#
# Use this when one or more workspace packages do not yet exist on
# npmjs.com. npm trusted publishing (OIDC) requires the package to
# already exist on the registry before a trusted publisher can be
# configured — there is no "pending trusted publisher" feature. This
# script creates the packages so trusted publishers can be set up via
# the web UI; subsequent releases use OIDC via .github/workflows/release.yml.
#
# Idempotent — already-published versions are skipped, so the script
# is safe to re-run if it hits a network error partway through.
#
# Usage:
#   NPM_TOKEN=npm_xxx ./tools/bootstrap-publish.sh
#
# After it completes:
#   1. For each package marked NEW in the output, visit its npmjs.com
#      settings page and configure trusted publishing:
#        org:      opensip-ai
#        repo:     opensip-tools
#        workflow: release.yml
#        environment: (leave empty)
#   2. Delete the npm token you just used.
#   3. Future releases follow the normal tag-driven flow in RELEASING.md.

set -euo pipefail

if [[ -z "${NPM_TOKEN:-}" ]]; then
  echo "error: NPM_TOKEN environment variable is required" >&2
  echo "  generate one at https://www.npmjs.com/settings/<user>/tokens" >&2
  echo "  (granular access token, scope @opensip-tools/*, publish permission)" >&2
  exit 1
fi

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$REPO_ROOT"

VERSION=$(node -p "require('./packages/core/package.json').version")
echo "Bootstrap target version: $VERSION"
echo

TARBALL_DIR=$(mktemp -d)
NPMRC=$(mktemp)
trap 'rm -rf "$TARBALL_DIR" "$NPMRC"' EXIT
echo "//registry.npmjs.org/:_authToken=${NPM_TOKEN}" > "$NPMRC"

# Mirror the publish order from .github/workflows/release.yml.
# Sequential by design — downstream packages reference upstream
# versions resolved by pnpm pack at pack time.
PACKAGES=(
  core
  contracts
  lang-typescript lang-rust lang-python lang-go lang-java lang-cpp
  fitness simulation
  checks-universal checks-typescript checks-python checks-go checks-java checks-cpp
  cli
)

published=0
skipped=0
newly_created=()

for pkg in "${PACKAGES[@]}"; do
  name="@opensip-tools/$pkg"

  # Has this exact version already been published?
  if npm --userconfig "$NPMRC" view "${name}@${VERSION}" version >/dev/null 2>&1; then
    echo "skip    $name@$VERSION (already on registry)"
    skipped=$((skipped + 1))
    continue
  fi

  # Does the package exist at all? (informational — affects trusted-publisher step)
  if ! npm --userconfig "$NPMRC" view "$name" version >/dev/null 2>&1; then
    newly_created+=("$name")
    marker="NEW"
  else
    marker="EXISTS"
  fi

  echo "pack    $name  [$marker]"
  pnpm --filter "$name" pack --pack-destination "$TARBALL_DIR" >/dev/null

  tarball="$TARBALL_DIR/opensip-tools-${pkg}-${VERSION}.tgz"
  if [[ ! -f "$tarball" ]]; then
    echo "error: expected tarball not found at $tarball" >&2
    echo "       $(ls "$TARBALL_DIR")" >&2
    exit 1
  fi

  echo "publish $name@$VERSION"
  npm --userconfig "$NPMRC" publish "$tarball" --access public
  published=$((published + 1))
done

echo
echo "==============================================================="
echo "  Bootstrap complete."
echo "  Published this run:           $published"
echo "  Skipped (already on registry): $skipped"
echo "==============================================================="

if (( ${#newly_created[@]} > 0 )); then
  echo
  echo "Newly created packages — configure trusted publishing for each:"
  for name in "${newly_created[@]}"; do
    encoded="${name/@/%40}"
    encoded="${encoded/\//%2F}"
    echo "  - $name"
    echo "      https://www.npmjs.com/package/$name/access"
  done
  echo
  echo "  Settings to enter (per package):"
  echo "    Organization: opensip-ai"
  echo "    Repository:   opensip-tools"
  echo "    Workflow:     release.yml"
  echo "    Environment:  (leave empty)"
fi

echo
echo "When done, delete the npm token used for this run."
