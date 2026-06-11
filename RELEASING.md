# Releasing

Releases are tag-driven. Pushing a tag matching `v*` triggers
`.github/workflows/release.yml`, which builds, tests, packs, and
publishes all 32 packages to npm via OIDC trusted publishing — no
`NPM_TOKEN` required. (31 are scoped `@opensip-tools/*`; the CLI itself
publishes under the unscoped name **`opensip-tools`** — the one package
end-users install directly, via `npm i -g opensip-tools`.)

## The 32 packages

> **Single source of truth.** This table, the publish order below, the
> npm-verify loop in step 6, the loops in `.github/workflows/release.yml`
> (preflight/pack/publish), and `scripts/bootstrap-publish.sh` are all
> derived from — or verified against — `scripts/release-package-order.mjs`
> (ADR-0017). The PR-time contract test
> `packages/cli/src/__tests__/release-package-order-contract.test.ts`
> fails CI if any of these surfaces drifts from that source, so adding,
> removing, or renaming a publishable package forces every surface to be
> updated together. Do not hand-edit the package list in one place only.

| Layer | Package | Path |
|-------|---------|------|
| Kernel | `@opensip-tools/core` | `packages/core` |
| Persistence | `@opensip-tools/datastore` | `packages/datastore` |
| Shared CLI | `@opensip-tools/contracts` | `packages/contracts` |
| Persistence | `@opensip-tools/session-store` | `packages/session-store` |
| Output | `@opensip-tools/output` | `packages/output` |
| Config | `@opensip-tools/config` | `packages/config` |
| Shared CLI | `@opensip-tools/cli-ui` | `packages/cli-ui` |
| Languages | `@opensip-tools/tree-sitter` | `packages/tree-sitter` |
| Languages | `@opensip-tools/lang-typescript` | `packages/languages/lang-typescript` |
| Languages | `@opensip-tools/lang-rust` | `packages/languages/lang-rust` |
| Languages | `@opensip-tools/lang-python` | `packages/languages/lang-python` |
| Languages | `@opensip-tools/lang-go` | `packages/languages/lang-go` |
| Languages | `@opensip-tools/lang-java` | `packages/languages/lang-java` |
| Languages | `@opensip-tools/lang-cpp` | `packages/languages/lang-cpp` |
| Tools | `@opensip-tools/fitness` | `packages/fitness/engine` |
| Tools | `@opensip-tools/simulation` | `packages/simulation/engine` |
| Tools | `@opensip-tools/graph` | `packages/graph/engine` |
| Graph adapters | `@opensip-tools/graph-adapter-common` | `packages/graph/graph-adapter-common` |
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

All 32 share the same version. The release workflow publishes them in
dependency order; downstream packages reference upstream versions in
their `dependencies`.

## Cutting a release

1. Bump every `version` field to the same value (e.g. `1.1.0`):
   ```bash
   pnpm -r --filter '@opensip-tools/*' exec npm version <patch|minor|major> --no-git-tag-version
   ```

   **The `--filter '@opensip-tools/*'` form matches only the 31 scoped
   packages — it misses the unscoped `opensip-tools` CLI
   (`packages/cli`) and the root `package.json`.** Bump those two
   explicitly (or run a script that walks every workspace
   `package.json` whose name is `opensip-tools` or starts with
   `@opensip-tools/`, plus the root). `scripts/verify-release.mjs`
   check 1 catches a half-bump — it requires the unscoped CLI to match
   the scoped consensus.

2. Update `CHANGELOG.md` — add a `## [X.Y.Z] — YYYY-MM-DD` entry at the
   top. The release-consistency gate (step 3) refuses to publish without
   one.

3. Sanity-check locally. The release workflow re-runs the **full PR gate**
   before it packs/publishes (ADR-0017 — the release gate must be at least
   as strict as the PR gate, because npm versions are immutable), so the
   local preflight must mirror it for a green local run to predict CI:
   ```bash
   pnpm install && pnpm -r run clean && pnpm build && pnpm typecheck && pnpm lint
   pnpm test:coverage             # per-package coverage thresholds (matches release CI)
   pnpm fit:ci && pnpm graph:ci   # dogfood gates now block release too (ADR-0017)
   pnpm docs:build                                # regenerate docs/web-generated/ at the new version pin
   pnpm verify-release --expected-version vX.Y.Z  # version + CHANGELOG + docs + cross-pkg deps + package-set + files-allowlist (11 checks)
   ```

   `pnpm lint` runs both ESLint and dependency-cruiser. Both must be
   zero-error. `pnpm test:coverage` enforces the per-package coverage
   thresholds (plain `pnpm test` skips them). `pnpm fit:ci` /
   `pnpm graph:ci` are the dogfood gates — after ADR-0017 they block the
   release, not just PR merge. `pnpm verify-release` runs the same gate CI
   uses (see `scripts/verify-release.mjs`); a green run of this complete
   set guarantees CI's pre-publish steps will also be green.

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
   for p in core datastore contracts session-store output config cli-ui tree-sitter fitness simulation graph dashboard \
            graph-adapter-common graph-typescript graph-python graph-rust graph-go graph-java \
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
   output in the 2026-05-29 contracts split).
4. **`@opensip-tools/session-store`** — depends on core, datastore, and
   contracts (StoredSession type). Owns the session SQLite schema +
   SessionRepo. Published before fitness / graph / cli, which persist
   sessions through it.
5. **`@opensip-tools/output`** — depends on core and contracts
   (SignalEnvelope type). The shared output layer: pure signal→string
   formatters (json, sarif, table) under `format/` and effectful sinks
   (file, cloud) under `sink/` (ADR-0011; renamed from `reporting`).
   Published before fitness / graph, whose findings the composition root
   formats through it.
5.5 **`@opensip-tools/config`** — the capability-configuration layer: the
   config composer + schema registry. Depends on core only (errors, yaml;
   adds Zod for schema validation). Published before the tools + CLI, which
   resolve their effective configuration through it. **Brand-new npm name**
   — needs a one-time trusted-publisher bootstrap (see "Bootstrapping a
   brand-new package").
6. **`@opensip-tools/cli-ui`** — Ink/React presentational primitives (banner,
   spinner, run header, theme). Leaf package, depends on no
   workspace-internal package; consumed by every tool live view + the
   CLI's static-render path.
7. **`@opensip-tools/tree-sitter`** — the tree-sitter parse substrate
   (ADR-0010): wraps `web-tree-sitter` and hosts the relocated graph
   node accessors. Depends on no workspace-internal package (only
   `web-tree-sitter`). Published before the language adapters and graph
   adapter packs, which parse through it (`lang-python|rust|go|java`,
   `graph-python|rust|go|java`, `graph-adapter-common`,
   `checks-python`).
8. **Language adapters** (lang-typescript first, then any order):
   `lang-typescript` → others. lang-typescript is published before the
   rest because it has more downstream consumers (every TS-AST check
   pack peer-depends on it transitively). The non-TS language adapters
   (`lang-python|rust|go|java`) additionally depend on
   `@opensip-tools/tree-sitter` (step 7).
9. **`@opensip-tools/dashboard`** — depends on core + contracts only.
   Published before `fitness` because fitness's `cli/dashboard.ts`
   imports `generateDashboardHtml` from it.
10. **`@opensip-tools/fitness`** — depends on core, contracts,
   datastore, session-store, lang-typescript, dashboard, and cli-ui.
   (No longer depends on the output layer — ADR-0011 moved egress to the
   composition root.)
11. **`@opensip-tools/simulation`** — depends on core, contracts, datastore.
12. **`@opensip-tools/graph`** — depends on core, contracts, datastore,
    session-store, and cli-ui. (Like fitness, sheds its former
    `reporting`/`output` edge under ADR-0011 — the root owns egress.)
12.5 **`@opensip-tools/graph-adapter-common`** — shared scaffolding for the
    tree-sitter adapters (discover/parse/walk/cache-key factories). Depends
    on the engine (`@opensip-tools/graph`), core, and
    `@opensip-tools/tree-sitter` (step 7). **Published AFTER the engine and
    BEFORE the four tree-sitter adapter packs**, which all declare it in
    `dependencies`. It is a library, not a discoverable adapter
    (`opensipTools.kind` is absent) and exports no `adapter`; it is pulled
    in transitively by graph-go/java/python/rust, never installed directly.
    (graph-typescript does NOT depend on it — it is TS-compiler-backed, not
    tree-sitter.)
13. **Graph adapter packs** — `@opensip-tools/graph-typescript`,
    `graph-python`, `graph-rust`, `graph-go`, `graph-java`. Each
    depends on the engine (`@opensip-tools/graph`) plus its parser
    (typescript / `@opensip-tools/tree-sitter`); the four tree-sitter
    packs additionally depend on `@opensip-tools/graph-adapter-common`
    (step 12.5). Independent of each other; published in any order within
    the group. All five are first-party CLI dependencies — the CLI bundles
    every graph adapter it loads by default (see step 15), so installing
    `opensip-tools` pulls them all in. (Only *third-party*
    `@opensip-tools/graph-*` adapters are opt-in: they're discovered by
    name pattern and installed explicitly.)
14. **Check packs** (any order within this group):
    `checks-typescript`, `checks-universal`, `checks-python`,
    `checks-go`, `checks-java`, `checks-cpp`, `checks-rust` — all
    peer-depend on fitness and are first-party CLI dependencies; the CLI
    bundles every check pack it loads by default (see step 15), so
    installing `opensip-tools` pulls them all in. The packed-install
    smoke test (`scripts/smoke-pack-scenarios.mjs`) asserts one slug per
    language pack, so a pack dropped from `packages/cli/package.json`
    fails the release gate rather than silently shipping a TS-only CLI.
15. **`opensip-tools`** (unscoped — the user-facing CLI) — depends on
    every tool, every check pack and every graph adapter pack the CLI
    loads by default, every language adapter, contracts, datastore,
    session-store, output, and cli-ui. Always published last. Its
    tarball is `opensip-tools-<version>.tgz` (no scope segment); the
    release workflow's `publish_unscoped` handles the bare name.

## Prerequisites (one-time setup)

- **npm Trusted Publishers** must be configured per-package on
  npmjs.com → package settings → Publishing access. Each of the 32
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

> **Current brand-new package (for the v2.10.0 release):**
> `@opensip-tools/config` — the new capability-configuration layer (ADR-0023).
> Genuinely new, so its name will be MISSING on npm and the OIDC release will
> 404 on it until its trusted publisher exists. Run the bootstrap path below
> once to create the name, then register its trusted publisher. This is a USER
> action at release time.

> **Historical brand-new packages (for the v2.7.0 release):**
> `@opensip-tools/output` and `@opensip-tools/tree-sitter` — verified MISSING on
> npm (`npm view` → 404), while the other 29 names already exist at 2.6.2.
> `output` is the new name for the renamed `@opensip-tools/reporting`;
> `tree-sitter` is genuinely new (ADR-0010). The v2.7.0 OIDC release will 404 on
> both names until their trusted publishers exist — run the bootstrap path below
> once to create them. (`@opensip-tools/graph-adapter-common`, the prior
> brand-new package, is now published at 2.6.2 and no longer needs
> bootstrapping.) Separately, the abandoned `@opensip-tools/reporting` should be
> `npm deprecate`d to steer consumers to `@opensip-tools/output`.

To unblock:

1. Generate a short-lived granular access token on npmjs.com (scope
   `@opensip-tools/*`, publish permission, 1-day expiry).

2. Run the bootstrap script with the token in the environment:
   ```bash
   NPM_TOKEN=npm_xxx ./scripts/bootstrap-publish.sh
   ```

   The script is **namespace-creation only** and **idempotent**. It
   iterates the 32 packages in dependency order, skips any whose NAME
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

Downgrades across schema changes are unsupported. The datastore stamps
its SQLite header (`PRAGMA user_version`) with the bundled migration count
after each successful migrate; on open, a CLI whose supported version is
**behind** the on-disk stamp fails fast with `DataStoreVersionError`
(direction Drizzle's migrator cannot detect on its own — the older CLI's
migrations are a prefix of what was applied, so `migrate()` would no-op and
later queries would hit missing columns). The message points the user at the
install script to upgrade, or at deleting
`<project>/opensip-tools/.runtime/datastore.sqlite` to continue on the older
CLI (cache rebuilds; session history is lost). The forward direction (newer
CLI, older or pre-guard `user_version 0` DB) auto-migrates and re-stamps with
no user action. Because the stamp is derived from the journal entry count,
adding a migration advances it automatically — there is no constant to bump.

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
