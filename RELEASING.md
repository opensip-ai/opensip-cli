# Releasing

Releases are tag-driven. Pushing a tag matching `v*` triggers
`.github/workflows/release.yml`, which builds, tests, packs, and
publishes all 29 packages to npm via OIDC trusted publishing — no
`NPM_TOKEN` required. (28 are scoped `@opensip-tools/*`; the CLI itself
publishes under the unscoped name **`opensip-tools`** — the one package
end-users install directly, via `npm i -g opensip-tools`.)

## The 29 packages

| Layer | Package | Path |
|-------|---------|------|
| Kernel | `@opensip-tools/core` | `packages/core` |
| Persistence | `@opensip-tools/datastore` | `packages/datastore` |
| Shared CLI | `@opensip-tools/contracts` | `packages/contracts` |
| Persistence | `@opensip-tools/session-store` | `packages/session-store` |
| Reporting | `@opensip-tools/reporting` | `packages/reporting` |
| Shared CLI | `@opensip-tools/cli-ui` | `packages/cli-ui` |
| Languages | `@opensip-tools/lang-typescript` | `packages/languages/lang-typescript` |
| Languages | `@opensip-tools/lang-rust` | `packages/languages/lang-rust` |
| Languages | `@opensip-tools/lang-python` | `packages/languages/lang-python` |
| Languages | `@opensip-tools/lang-go` | `packages/languages/lang-go` |
| Languages | `@opensip-tools/lang-java` | `packages/languages/lang-java` |
| Languages | `@opensip-tools/lang-cpp` | `packages/languages/lang-cpp` |
| Tools | `@opensip-tools/fitness` | `packages/fitness/engine` |
| Tools | `@opensip-tools/simulation` | `packages/simulation/engine` |
| Tools | `@opensip-tools/graph` | `packages/graph/engine` |
| Graph adapters | `@opensip-tools/graph-typescript` | `packages/graph/graph-typescript` |
| Graph adapters | `@opensip-tools/graph-python` | `packages/graph/graph-python` |
| Graph adapters | `@opensip-tools/graph-rust` | `packages/graph/graph-rust` |
| Graph adapters | `@opensip-tools/graph-go` | `packages/graph/graph-go` |
| Graph adapters | `@opensip-tools/graph-java` | `packages/graph/graph-java` |
| Tools | `@opensip-tools/dashboard` | `packages/dashboard` |
| Check packs | `@opensip-tools/checks-typescript` | `packages/fitness/checks-typescript` |
| Check packs | `@opensip-tools/checks-universal` | `packages/fitness/checks-universal` |
| Check packs | `@opensip-tools/checks-python` | `packages/fitness/checks-python` |
| Check packs | `@opensip-tools/checks-go` | `packages/fitness/checks-go` |
| Check packs | `@opensip-tools/checks-java` | `packages/fitness/checks-java` |
| Check packs | `@opensip-tools/checks-cpp` | `packages/fitness/checks-cpp` |
| Check packs | `@opensip-tools/checks-rust` | `packages/fitness/checks-rust` |
| CLI | `opensip-tools` (unscoped) | `packages/cli` |

All 29 share the same version. The release workflow publishes them in
dependency order; downstream packages reference upstream versions in
their `dependencies`.

## Cutting a release

1. Bump every `version` field to the same value (e.g. `1.1.0`):
   ```bash
   pnpm -r --filter '@opensip-tools/*' exec npm version <patch|minor|major> --no-git-tag-version
   ```

2. Update `CHANGELOG.md` — add a `## [X.Y.Z] — YYYY-MM-DD` entry at the
   top. The release-consistency gate (step 3) refuses to publish without
   one.

3. Sanity-check locally:
   ```bash
   pnpm install && pnpm typecheck && pnpm test && pnpm lint
   pnpm docs:build                                # regenerate docs/web-generated/ at the new version pin
   pnpm verify-release --expected-version vX.Y.Z  # version + CHANGELOG + docs + cross-pkg deps
   ```

   `pnpm lint` runs both ESLint and dependency-cruiser. Both must be
   zero-error. `pnpm verify-release` runs the same gate CI uses (see
   `scripts/verify-release.mjs`); a green local run guarantees CI's
   pre-publish step will also be green.

4. Commit, tag, push:
   ```bash
   git commit -am "chore: release X.Y.Z"
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

5. Watch the run:
   ```bash
   gh run watch $(gh run list --workflow=release.yml --limit 1 --json databaseId -q '.[0].databaseId')
   ```

6. Verify on npm:
   ```bash
   for p in core datastore contracts session-store reporting cli-ui fitness simulation graph dashboard \
            graph-typescript graph-python graph-rust graph-go graph-java \
            lang-typescript lang-rust lang-python lang-go lang-java lang-cpp \
            checks-typescript checks-universal checks-python checks-go checks-java checks-cpp checks-rust; do
     printf '%-40s %s\n' "@opensip-tools/$p" "$(npm view "@opensip-tools/$p" version 2>/dev/null || echo MISSING)"
   done
   # The CLI publishes under the unscoped name:
   printf '%-40s %s\n' "opensip-tools" "$(npm view opensip-tools version 2>/dev/null || echo MISSING)"
   ```

## Publish order

The release workflow publishes packages sequentially in dependency
order. Racing a downstream publish ahead of its upstream produces a
broken release because the upstream version isn't in the registry yet
when downstream's `dependencies` field is resolved.

Order:

1. **`@opensip-tools/core`** — depends on nothing else workspace-internal.
2. **`@opensip-tools/datastore`** — depends on core. Bundles SQLite + Drizzle persistence.
3. **`@opensip-tools/contracts`** — depends on core only (types-only; the
   former datastore + drizzle-orm runtime deps moved to session-store /
   reporting in the 2026-05-29 contracts split).
4. **`@opensip-tools/session-store`** — depends on core, datastore, and
   contracts (StoredSession type). Owns the session SQLite schema +
   SessionRepo. Published before fitness / graph / cli, which persist
   sessions through it.
5. **`@opensip-tools/reporting`** — depends on core and contracts
   (CliOutput type). Owns SARIF build + cloud report. Published before
   fitness / graph, which report findings through it.
6. **`@opensip-tools/cli-ui`** — Ink/React presentational primitives (banner,
   spinner, run header, theme). Leaf package, depends on no
   workspace-internal package; consumed by every tool live view + the
   CLI's static-render path.
7. **Language adapters** (lang-typescript first, then any order):
   `lang-typescript` → others. lang-typescript is published before the
   rest because it has more downstream consumers (every TS-AST check
   pack peer-depends on it transitively).
8. **`@opensip-tools/dashboard`** — depends on core + contracts only.
   Published before `fitness` because fitness's `cli/dashboard.ts`
   imports `generateDashboardHtml` from it.
9. **`@opensip-tools/fitness`** — depends on core, contracts,
   datastore, session-store, reporting, lang-typescript, dashboard, and cli-ui.
10. **`@opensip-tools/simulation`** — depends on core, contracts, datastore.
11. **`@opensip-tools/graph`** — depends on core, contracts, datastore,
    session-store, reporting, and cli-ui.
12. **Graph adapter packs** — `@opensip-tools/graph-typescript`,
    `graph-python`, `graph-rust`, `graph-go`, `graph-java`. Each
    depends on the engine (`@opensip-tools/graph`) plus its parser
    (typescript / tree-sitter-*). Independent of each other; published
    in any order within the group. All five are first-party CLI
    dependencies — the CLI bundles every graph adapter it loads by
    default (see step 14), so installing `opensip-tools` pulls
    them all in. (Only *third-party* `@opensip-tools/graph-*` adapters
    are opt-in: they're discovered by name pattern and installed
    explicitly.)
13. **Check packs** (any order within this group):
    `checks-typescript`, `checks-universal`, `checks-python`,
    `checks-go`, `checks-java`, `checks-cpp`, `checks-rust` — all
    peer-depend on fitness. `checks-rust` is opt-in (not a CLI
    dependency); install explicitly.
14. **`opensip-tools`** (unscoped — the user-facing CLI) — depends on
    every tool, every check pack and every graph adapter pack the CLI
    loads by default, every language adapter, contracts, datastore,
    session-store, reporting, and cli-ui. Always published last. Its
    tarball is `opensip-tools-<version>.tgz` (no scope segment); the
    release workflow's `publish_unscoped` handles the bare name.

## Prerequisites (one-time setup)

- **npm Trusted Publishers** must be configured per-package on
  npmjs.com → package settings → Publishing access. Each of the 29
  packages needs an entry pointing to:
  - Organization: `opensip-ai`
  - Repository: `opensip-tools`
  - Workflow: `release.yml`

  npm has **no "pending trusted publisher" feature** — the package
  must already exist on the registry before its trusted publisher can
  be configured. See "Bootstrapping a brand-new package" below for the
  one-time path to create a package on npm so its trusted publisher
  becomes configurable.

## Bootstrapping a brand-new package

When the workspace gains a new `@opensip-tools/*` package (or an
existing package gets renamed — `cli-shared` → `contracts` was the
first instance), the next release workflow will fail at the publish
step for that package with `404 PUT`. Cause: OIDC publishing routes
auth through the trusted publisher entry; with no entry registered for
the package name, npm responds 404. The release workflow's preflight
step warns about this case before publishing starts.

To unblock:

1. Generate a short-lived granular access token on npmjs.com (scope
   `@opensip-tools/*`, publish permission, 1-day expiry).

2. Run the bootstrap script with the token in the environment:
   ```bash
   NPM_TOKEN=npm_xxx ./scripts/bootstrap-publish.sh
   ```

   The script is **namespace-creation only** and **idempotent**. It
   iterates the 29 packages in dependency order, skips any whose NAME
   already exists on npm (those get v`X.Y.Z` via the OIDC tagged
   release, with provenance), packs and publishes only the brand-new
   names using the token, and at the end prints a list of newly-created
   packages with direct links to their npmjs.com settings pages.

   We deliberately do NOT publish already-existing package names from
   this script: token-based publishes have no provenance, and npm
   versions are immutable, so doing so would permanently lock v`X.Y.Z`
   without provenance and block the OIDC release from re-publishing.

3. Visit each link the script printed and add the trusted publisher
   entry (org/repo/workflow as above).

4. Delete the npm token.

5. Subsequent releases follow the normal tag-driven flow — OIDC takes
   over once the trusted publisher entries exist.

Tarballs created by the bootstrap script are published **without
provenance** (provenance requires OIDC, which the script doesn't have).
This is a one-time visible artifact in the npm UI; all subsequent
versions published by the release workflow include provenance.

## Schema evolution between versions

opensip-tools v2 stores runtime state in SQLite via Drizzle. Drizzle
migrations live under `packages/datastore/migrations/` and are applied
automatically by `DataStoreFactory.open()` on every CLI invocation.

When a release modifies any schema file —
`packages/contracts/src/persistence/schema/*.ts`,
`packages/graph/engine/src/persistence/schema.ts`, or
`packages/fitness/engine/src/persistence/schema.ts` — the release
workflow needs a fresh migration. Steps:

1. Edit the schema (e.g. add a column to `catalog_functions`).
2. Run `pnpm --filter=@opensip-tools/datastore db:generate`. Drizzle-kit
   diffs against the last applied migration and writes a new
   `NNNN_<name>.sql` file under `packages/datastore/migrations/`.
3. **Read and review the generated SQL before committing.** Drizzle-kit's
   automatic diffing handles most cases correctly, but column renames are
   detected as drop+add (data loss). For renames, hand-edit the generated
   SQL to use `ALTER TABLE ... RENAME COLUMN`.
4. Commit the SQL alongside the schema edit. Migration files **must**
   ship in the published tarball — `packages/datastore/package.json`'s
   `files: ["dist", "migrations"]` allowlist enforces this. If you add
   a `files` entry that excludes `migrations/`, users hit "no migrations
   folder" on first run.
5. **Never edit a previously-committed migration file.** Drizzle tracks
   applied migrations by content hash; editing one in place leaves users
   in undefined state. Add a new migration instead.

Downgrades across schema changes are unsupported. A user who downgrades
will see `DataStoreMigrationError` on next run; the recovery message
points them at deleting `<project>/opensip-tools/.runtime/datastore.sqlite`
(cache rebuilds; session history is lost).

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

The published versions are **immutable** — npm only allows unpublish
within 72 hours and only if no dependents exist; treat every
successful publish as permanent.

The release workflow's publish step is **idempotent**: each package is
publish-only-if-the-exact-version-isn't-already-on-npm. So:

- **Network blip / npm flake mid-publish**: re-run the workflow on
  the same tag. Already-published packages will be skipped; the loop
  resumes from the failed one.
- **Trusted publisher missing for a new package**: the publish step
  will fail with `404 PUT`. Fix it via the bootstrap path above
  (publish manually with a token, configure trusted publisher), then
  re-run the workflow on the same tag.
- **Some other failure that produced a partial release at version
  X.Y.Z**: bump to X.Y.(Z+1) and re-tag. The orphaned partial release
  is harmless — no consumers will have referenced it via lockfiles
  yet, and you can `npm deprecate` the orphan versions if you want
  them invisible.
