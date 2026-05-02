# Releasing

Releases are tag-driven. Pushing a tag matching `v*` triggers
`.github/workflows/release.yml`, which builds, tests, packs, and
publishes all four `@opensip-tools/*` packages to npm via OIDC trusted
publishing — no `NPM_TOKEN` required.

## Cutting a release

1. Bump the `version` field in all four package manifests to the same
   value (e.g. `0.2.5`):
   - `packages/core/package.json`
   - `packages/checks-builtin/package.json`
   - `packages/simulation/package.json`
   - `packages/cli/package.json`

   Or in one shot:
   ```bash
   pnpm -r --filter '@opensip-tools/*' exec npm version <patch|minor|major> --no-git-tag-version
   ```

2. Sanity-check locally:
   ```bash
   pnpm install && pnpm typecheck && pnpm test
   ```

3. Commit, tag, push:
   ```bash
   git commit -am "chore: release X.Y.Z"
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

4. Watch the run:
   ```bash
   gh run watch $(gh run list --workflow=release.yml --limit 1 --json databaseId -q '.[0].databaseId')
   ```

5. Verify on npm:
   ```bash
   for p in core checks-builtin simulation cli; do
     npm view "@opensip-tools/$p" version
   done
   ```

## Prerequisites (one-time setup)

- **npm Trusted Publishers** must be configured per-package on
  npmjs.com → package settings → Publishing access. Each of the four
  scoped packages needs an entry pointing to:
  - Organization: `opensip-ai`
  - Repository: `opensip-tools`
  - Workflow: `release.yml`

## Why the workflow looks the way it does

These steps are non-obvious. **Do not "simplify" them** without
understanding why they exist:

1. **`npm install --prefix "$HOME/.npm-cli" npm@11`** — npm 11.5+ is
   required for the OIDC token-exchange handshake with GitHub Actions.
   Node 22 ships with npm 10. Installing npm globally (`npm install -g
   npm@11`) reliably **corrupts mid-install** on hosted runners with
   `Cannot find module 'promise-retry'` because npm unlinks files of
   its own running process. Installing to a separate prefix and
   prepending to `$GITHUB_PATH` avoids the self-replacement.

2. **`pnpm pack` then `npm publish <tarball>`** — `pnpm publish` uses
   its own HTTP client and does **not** perform the OIDC token
   exchange, so it always hits the registry unauthenticated and gets
   `404 Not Found` on the PUT. `pnpm pack` resolves `workspace:*`
   dependencies into the tarball; `npm publish <tarball>` then does
   the OIDC handshake and uploads the already-packed bits.

3. **Publish order is sequential, not parallel** — `core` →
   `checks-builtin` → `simulation` → `cli`. Downstream packages
   reference upstream versions in their `dependencies`, so racing a
   downstream publish ahead of its upstream produces a broken release.

## If a release fails

The published versions are **immutable**. If the workflow fails after
some packages have published, do not retry the same version — bump to
the next patch and re-tag. npm only allows unpublish within 72 hours
and only if no dependents exist; treat every successful publish as
permanent.
