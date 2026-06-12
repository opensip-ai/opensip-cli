#!/usr/bin/env bash
#
# One-time bootstrap publish for @opensip-cli/*.
#
# Use this when one or more workspace packages do not yet exist on
# npmjs.com. npm trusted publishing (OIDC) requires the package to
# already exist on the registry before a trusted publisher can be
# configured — there is no "pending trusted publisher" feature. This
# script creates brand-new package names so trusted publishers can be
# set up via the web UI; subsequent releases use OIDC via
# .github/workflows/release.yml.
#
# Namespace-creation only. Packages whose NAME already exists on npm
# (at any version) are skipped — their v$VERSION will be published by
# the OIDC tagged release with provenance. Publishing already-existing
# names here would ship the new version without provenance and then
# permanently block OIDC from re-publishing (npm versions are
# immutable), so we deliberately avoid it.
#
# Idempotent — re-running after a partial failure skips both
# already-existing names and brand-new names whose first bootstrap
# publish has now landed.
#
# Usage:
#   NPM_TOKEN=npm_xxx ./scripts/bootstrap-publish.sh
#
# After it completes:
#   1. For each package marked NEW in the output, visit its npmjs.com
#      settings page and configure trusted publishing:
#        org:      opensip-ai
#        repo:     opensip-cli
#        workflow: release.yml
#        environment: (leave empty)
#   2. Delete the npm token you just used.
#   3. Future releases follow the normal tag-driven flow in RELEASING.md.

set -euo pipefail

if [[ -z "${NPM_TOKEN:-}" ]]; then
  echo "error: NPM_TOKEN environment variable is required" >&2
  echo "  generate one at https://www.npmjs.com/settings/<user>/tokens" >&2
  echo "  (granular access token, scope @opensip-cli/*, publish permission)" >&2
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

# The package list + ORDER is DERIVED from scripts/release-package-order.mjs
# (the single source of truth — ADR-0017), the same source the release
# workflow's pack/preflight/publish loops read. Sequential by design —
# downstream packages reference upstream versions resolved by pnpm pack at
# pack time. Do NOT re-hand-list packages here; edit that script and every
# release surface follows. (`--print names` emits the unscoped tarball-segment
# tokens in dependency order, CLI last.)
PACKAGES=()
while IFS= read -r pkg; do
  PACKAGES+=("$pkg")
done < <(node "$REPO_ROOT/scripts/release-package-order.mjs" --print names)

published=0
skipped=0
newly_created=()

for pkg in "${PACKAGES[@]}"; do
  # The CLI publishes under the unscoped name `opensip-cli`; everything else
  # is `@opensip-cli/<pkg>`. pnpm pack names the tarball accordingly:
  # unscoped → `opensip-cli-<ver>.tgz`, scoped → `opensip-cli-<pkg>-<ver>.tgz`.
  if [[ "$pkg" == "opensip-cli" ]]; then
    name="opensip-cli"
    tarball="$TARBALL_DIR/opensip-cli-${VERSION}.tgz"
  else
    name="@opensip-cli/$pkg"
    tarball="$TARBALL_DIR/opensip-cli-${pkg}-${VERSION}.tgz"
  fi

  # Namespace-creation only: skip any package whose NAME already exists on
  # npm, regardless of version. Existing packages already have trusted
  # publishers configured, so their v$VERSION should be published by the
  # OIDC tagged release (with provenance) — not by this token-based script
  # (no provenance, and immutable once published would lock v$VERSION
  # without provenance forever).
  if npm --userconfig "$NPMRC" view "$name" version >/dev/null 2>&1; then
    echo "skip    $name (name exists; OIDC release will publish v$VERSION with provenance)"
    skipped=$((skipped + 1))
    continue
  fi

  # Brand-new package name — must be bootstrapped here so its trusted
  # publisher entry becomes configurable. This single token-based publish
  # ships without provenance; all subsequent versions get provenance via
  # OIDC. Accepted tradeoff documented in RELEASING.md.
  newly_created+=("$name")

  echo "pack    $name  [NEW]"
  pnpm --filter "$name" pack --pack-destination "$TARBALL_DIR" >/dev/null

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
  echo "    Repository:   opensip-cli"
  echo "    Workflow:     release.yml"
  echo "    Environment:  (leave empty)"
fi

echo
echo "When done, delete the npm token used for this run."
