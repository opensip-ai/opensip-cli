# Releasing

Releases are tag-driven. Pushing a tag matching `v*` triggers
`.github/workflows/release.yml`, which builds, tests, packs, and
publishes all 17 `@opensip-tools/*` packages to npm via OIDC trusted
publishing — no `NPM_TOKEN` required.

## The 17 packages

| Layer | Package | Path |
|-------|---------|------|
| Kernel | `@opensip-tools/core` | `packages/core` |
| Shared CLI | `@opensip-tools/contracts` | `packages/contracts` |
| Languages | `@opensip-tools/lang-typescript` | `packages/languages/lang-typescript` |
| Languages | `@opensip-tools/lang-rust` | `packages/languages/lang-rust` |
| Languages | `@opensip-tools/lang-python` | `packages/languages/lang-python` |
| Languages | `@opensip-tools/lang-go` | `packages/languages/lang-go` |
| Languages | `@opensip-tools/lang-java` | `packages/languages/lang-java` |
| Languages | `@opensip-tools/lang-cpp` | `packages/languages/lang-cpp` |
| Tools | `@opensip-tools/fitness` | `packages/fitness/engine` |
| Tools | `@opensip-tools/simulation` | `packages/simulation/engine` |
| Check packs | `@opensip-tools/checks-typescript` | `packages/fitness/checks-typescript` |
| Check packs | `@opensip-tools/checks-universal` | `packages/fitness/checks-universal` |
| Check packs | `@opensip-tools/checks-python` | `packages/fitness/checks-python` |
| Check packs | `@opensip-tools/checks-go` | `packages/fitness/checks-go` |
| Check packs | `@opensip-tools/checks-java` | `packages/fitness/checks-java` |
| Check packs | `@opensip-tools/checks-cpp` | `packages/fitness/checks-cpp` |
| CLI | `@opensip-tools/cli` | `packages/cli` |

All 17 share the same version. The release workflow publishes them in
dependency order; downstream packages reference upstream versions in
their `dependencies`.

## Cutting a release

1. Bump every `version` field to the same value (e.g. `1.1.0`):
   ```bash
   pnpm -r --filter '@opensip-tools/*' exec npm version <patch|minor|major> --no-git-tag-version
   ```

2. Sanity-check locally:
   ```bash
   pnpm install && pnpm typecheck && pnpm test && pnpm lint
   ```

   `pnpm lint` runs both ESLint and dependency-cruiser. Both must be
   zero-error.

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
   for p in core contracts cli fitness simulation \
            lang-typescript lang-rust lang-python lang-go lang-java lang-cpp \
            checks-typescript checks-universal checks-python checks-go checks-java checks-cpp; do
     printf '%-40s %s\n' "@opensip-tools/$p" "$(npm view "@opensip-tools/$p" version 2>/dev/null || echo MISSING)"
   done
   ```

## Publish order

The release workflow publishes packages sequentially in dependency
order. Racing a downstream publish ahead of its upstream produces a
broken release because the upstream version isn't in the registry yet
when downstream's `dependencies` field is resolved.

Order:

1. **`@opensip-tools/core`** — depends on nothing else workspace-internal.
2. **`@opensip-tools/contracts`** — depends on core.
3. **Language adapters** (lang-typescript first, then any order):
   `lang-typescript` → others. lang-typescript is published before the
   rest because it has more downstream consumers (every TS-AST check
   pack peer-depends on it transitively).
4. **`@opensip-tools/fitness`** — depends on core, contracts, and
   lang-typescript.
5. **`@opensip-tools/simulation`** — depends on core, contracts.
6. **Check packs** (any order within this group):
   `checks-typescript`, `checks-universal`, `checks-python`,
   `checks-go`, `checks-java`, `checks-cpp` — all peer-depend on
   fitness.
7. **`@opensip-tools/cli`** — depends on every tool, every check pack
   the CLI loads by default, every language adapter, and contracts.
   Always published last.

## Prerequisites (one-time setup)

- **npm Trusted Publishers** must be configured per-package on
  npmjs.com → package settings → Publishing access. Each of the 17
  packages needs an entry pointing to:
  - Organization: `opensip-ai`
  - Repository: `opensip-tools`
  - Workflow: `release.yml`

  When adding a new package to the workspace, configure trusted
  publishing BEFORE the next release tag, or that package will fail
  to publish.

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

3. **Publish order is sequential, not parallel** — see "Publish order"
   above. Racing produces broken releases.

## If a release fails

The published versions are **immutable**. If the workflow fails after
some packages have published, **do not retry the same version** — bump
to the next patch and re-tag. npm only allows unpublish within 72 hours
and only if no dependents exist; treat every successful publish as
permanent.

If the workflow failed before any package published, retrying the same
tag is safe — but verify with `npm view <pkg> version` first to be
sure none made it through.

## Smoke testing a release locally (Verdaccio)

The repo's `tools/oop-smoke/` sets up a local Verdaccio registry that
mirrors the publish flow without touching npmjs.com. Run it before
cutting a real release if you want to validate the tarball contents:

```bash
# Start Verdaccio, pack everything, publish to localhost, install in a
# fresh consumer project, run the CLI. Full procedure: docs/release-smoke-test.md.
```
