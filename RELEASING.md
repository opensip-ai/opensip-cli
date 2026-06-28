# Releasing

Releases are tag-driven. Pushing a tag matching `v*` triggers
`.github/workflows/release.yml`, which builds, tests, packs, and publishes the
workspace packages to npm with OIDC trusted publishing.

The user-facing npm package is `opensip-cli`. It installs the `opensip` command.

### Producer provenance

Ordinary tag releases publish every package with **OIDC trusted publishing** and
**npm provenance** (`npm publish <tarball> --provenance`). `pnpm supply-chain:verify`
runs in CI and in this workflow before any publish step. The only documented
exception is the one-time **first-publish bootstrap** for brand-new package names
(see [One-time npm bootstrap](#2-one-time-npm-bootstrap-brand-new-names-only)):
that path uses a short-lived token and ships **without** provenance. Do not use
bootstrap for names that already exist on npm.

Consumption-side verification (install/load provenance checks for third-party
packages) is a separate trust gate — see
[ADR-0068](../docs/decisions/ADR-0068-consumption-side-verification-policy.md)
and [ADR-0061](../docs/decisions/ADR-0061-tool-platform-launch-posture-and-extension-trust-tiers.md).

## The 39 packages

`scripts/release-package-order.mjs` is the source of truth for the publishable
package set and dependency order. The release workflow, bootstrap script, and
contract tests derive from or verify against that source.

| Layer          | Package                             | Path                                  |
| -------------- | ----------------------------------- | ------------------------------------- |
| Kernel         | `@opensip-cli/core`                 | `packages/core`                       |
| Persistence    | `@opensip-cli/datastore`            | `packages/datastore`                  |
| Shared CLI     | `@opensip-cli/contracts`            | `packages/contracts`                  |
| Authoring      | `@opensip-cli/tool-test-kit`        | `packages/tool-test-kit`              |
| Substrate      | `@opensip-cli/clone-detection`      | `packages/clone-detection`            |
| Persistence    | `@opensip-cli/session-store`        | `packages/session-store`              |
| Output         | `@opensip-cli/output`               | `packages/output`                     |
| Config         | `@opensip-cli/config`               | `packages/config`                     |
| Targeting      | `@opensip-cli/targeting`            | `packages/targeting`                  |
| Shared CLI     | `@opensip-cli/cli-ui`               | `packages/cli-ui`                     |
| Shared CLI     | `@opensip-cli/cli-live`             | `packages/cli-live`                   |
| Languages      | `@opensip-cli/tree-sitter`          | `packages/tree-sitter`                |
| Languages      | `@opensip-cli/lang-typescript`      | `packages/languages/lang-typescript`  |
| Languages      | `@opensip-cli/lang-rust`            | `packages/languages/lang-rust`        |
| Languages      | `@opensip-cli/lang-python`          | `packages/languages/lang-python`      |
| Languages      | `@opensip-cli/lang-go`              | `packages/languages/lang-go`          |
| Languages      | `@opensip-cli/lang-java`            | `packages/languages/lang-java`        |
| Languages      | `@opensip-cli/lang-cpp`             | `packages/languages/lang-cpp`         |
| Tools          | `@opensip-cli/dashboard`            | `packages/dashboard`                  |
| Substrate      | `@opensip-cli/external-tool-adapter` | `packages/external-tool-adapter`     |
| Tools          | `@opensip-cli/fitness`              | `packages/fitness/engine`             |
| Tools          | `@opensip-cli/simulation`           | `packages/simulation/engine`          |
| Tools          | `@opensip-cli/graph`                | `packages/graph/engine`               |
| Tools          | `@opensip-cli/yagni`                | `packages/yagni/engine`               |
| Graph adapters | `@opensip-cli/graph-adapter-common` | `packages/graph/graph-adapter-common` |
| Graph adapters | `@opensip-cli/graph-typescript`     | `packages/graph/graph-typescript`     |
| Graph adapters | `@opensip-cli/graph-python`         | `packages/graph/graph-python`         |
| Graph adapters | `@opensip-cli/graph-rust`           | `packages/graph/graph-rust`           |
| Graph adapters | `@opensip-cli/graph-go`             | `packages/graph/graph-go`             |
| Graph adapters | `@opensip-cli/graph-java`           | `packages/graph/graph-java`           |
| Tools          | `@opensip-cli/mcp`                  | `packages/mcp`                        |
| Check packs    | `@opensip-cli/checks-universal`     | `packages/fitness/checks-universal`   |
| Check packs    | `@opensip-cli/checks-typescript`    | `packages/fitness/checks-typescript`  |
| Check packs    | `@opensip-cli/checks-python`        | `packages/fitness/checks-python`      |
| Check packs    | `@opensip-cli/checks-go`            | `packages/fitness/checks-go`          |
| Check packs    | `@opensip-cli/checks-java`          | `packages/fitness/checks-java`        |
| Check packs    | `@opensip-cli/checks-cpp`           | `packages/fitness/checks-cpp`         |
| Check packs    | `@opensip-cli/checks-rust`          | `packages/fitness/checks-rust`        |
| CLI            | `opensip-cli` (unscoped)            | `packages/cli`                        |

All publishable packages share the same version. The release workflow publishes
them in dependency order, with `opensip-cli` last.

## Version Surfaces (what a bump touches)

The product version has **one source of truth** —
`packages/core/package.json#version` — and fans out to three kinds of surface.
The mechanical sweep is automated by **`scripts/bump-version.mjs`** (with a
`--check` drift guard); this section explains what it touches so the manual
parts are obvious. (`git grep -n '<old-version>'` after a bump is the backstop.)

### 1. Version fields (hand-set, lockstep)

All 39 publishable packages **plus** the private root (`@opensip-cli/root`) and
the private `@opensip-cli/test-support` carry one shared version — 41
`package.json` files. The bump script matches `name === 'opensip-cli'`,
`name === '@opensip-cli/root'`, or `name.startsWith('@opensip-cli/')`. Fixture
packages use other scopes (`@fixture/*`, `@example/*`, `@medium/*`,
`@opensip-cli-fixture/*`, bare names) and are deliberately **not** touched.

Internal dependencies all use `workspace:*`, so `pnpm pack` rewrites them to the
concrete version at publish time. **A bump never edits dependency specifiers.**
Refresh the lockfile afterward with `pnpm install --lockfile-only`.

### 2. Derived surfaces (DO NOT hand-edit — regenerate)

Each reads `packages/core/package.json#version`:

| Surface                                   | Regenerate with                                                               | Pins                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------- |
| CLI `--version`                           | nothing — `readPackageVersion` walks to the nearest `package.json` at runtime | the installed version                                 |
| Per-package `README.md` (×36 scoped)      | `pnpm docs:readmes`                                                           | `tree/vX.Y.Z/…` source + catalog links                |
| `docs/web-generated/**` + `manifest.json` | `pnpm docs:build`                                                             | `blob/vX.Y.Z/…` links; manifest `version` / `rawBase` |

CI fails if these are stale — `pnpm docs:readmes:check` and `pnpm docs:check`,
both run by `verify-release`.

### 3. Hand-authored surfaces (the bump script swaps the version token; you own the prose)

`scripts/bump-version.mjs` swaps the version token in: the `docs/public/**`
`release: vX.Y.Z` frontmatter (~55 files, including the top-level `README.md`),
the scope-qualified peer-dep ranges (`"@opensip-cli/x": "^X.Y.Z"`), the
`SECURITY.md` supported-release row, the `CLAUDE.md` Project Status line, and the
curated prose markers ("Last verified at vX.Y.Z", the package-catalog "(all at
`X.Y.Z`)" line, the install-script `OPENSIP_CLI_VERSION=` example, the
website-integration manifest example, the graph `cacheKey: "eng=X.Y.Z|…"`).

It deliberately leaves to you: the **`CHANGELOG.md`** narrative entry, and — when
crossing the `1.0` boundary — the **peer-dependency _guidance_ prose** ("pin to
the 0.x line" vs. "pin to majors"; a `^0.y` caret locks to the minor). Example
third-party plugin/pack `"version"` fields in `docs/public` are the _example's
own_ version (independent of opensip-cli) and are intentionally left alone.

### Pre-1.0 (`0.x`) caveat

While opensip-cli is `0.x` the public API is not frozen (ADR-0012). Under
npm/Cargo caret semantics a `^0.y.z` range locks to the **minor**, so every
`0.y` bump is a potential breaking change — peer-dependency guidance must read
`^0.1.0`, not `^1.0.0`, and "pin to majors; minor is safe" only becomes true at
`1.0.0`.

## Cutting A Release

1. Bump the version across every hand-maintained surface, then regenerate the
   derived ones (see "Version Surfaces" above):

   ```bash
   node scripts/bump-version.mjs <new-version>   # 40 package.json + docs + SECURITY + prose
   pnpm install --lockfile-only                  # refresh the lockfile
   pnpm docs:readmes && pnpm docs:build          # regenerate version-pinned READMEs + web docs
   node scripts/bump-version.mjs --check         # assert no surface drifted
   ```

2. Update `CHANGELOG.md` with the release entry.

3. Run the local preflight. Do not tag or push a release until this passes.
   This command mirrors the tag-driven release lane before publish, including a
   fresh Turbo coverage run (`--force`) so stale cached package coverage cannot
   mask a CI threshold failure:

   ```bash
   pnpm release:preflight --expected-version v0.1.0
   ```

   `pnpm test:coverage` is useful during development, but release prep must use
   `pnpm test:coverage:fresh` directly or through `pnpm release:preflight` so
   package-level coverage thresholds are recomputed locally before the immutable
   npm publish lane starts.

4. Commit, tag, and push:

   ```bash
   git commit -am "chore: release 0.1.0"
   git tag v0.1.0
   git push origin main v0.1.0
   ```

5. Watch the release workflow:

   ```bash
   gh run watch $(gh run list --workflow=release.yml --limit 1 --json databaseId -q '.[0].databaseId')
   ```

6. Verify npm after publish:

   ```bash
   node scripts/verify-release-publish-surface.mjs --expected-version vX.Y.Z --tag latest
   ```

   Or inspect manually:

   ```bash
  for p in core datastore contracts tool-test-kit clone-detection session-store output config targeting cli-ui cli-live tree-sitter \
            lang-typescript lang-rust lang-python lang-go lang-java lang-cpp \
            dashboard external-tool-adapter fitness simulation graph yagni graph-adapter-common graph-typescript \
            graph-python graph-rust graph-go graph-java mcp checks-universal checks-typescript \
            checks-python checks-go checks-java checks-cpp checks-rust; do
     printf '%-40s %s\n' "@opensip-cli/$p" "$(npm view "@opensip-cli/$p" version 2>/dev/null || echo MISSING)"
   done
   printf '%-40s %s\n' "opensip-cli" "$(npm view opensip-cli version 2>/dev/null || echo MISSING)"
   ```

## Partial publish recovery

The release workflow publishes every package to a version-scoped staging dist-tag
(`release-candidate-<version>`) first, then promotes the full set to `latest` in
one batch. If the workflow fails mid-loop, `latest` should still point at the
previous complete release.

**Detect a partial publish:**

```bash
# Staging lane (incomplete set is OK here while the workflow is running)
node scripts/verify-release-publish-surface.mjs --expected-version vX.Y.Z --tag release-candidate-X.Y.Z

# Consumer-visible lane (must be complete before calling the release good)
node scripts/verify-release-publish-surface.mjs --expected-version vX.Y.Z --tag latest
```

**Safe recovery:**

1. Re-run the failed release workflow on the **same tag**. Publish is idempotent:
   packages already on npm are skipped; promotion runs again for any version that
   exists but is not yet on `latest`.
2. If the workflow cannot be re-run, publish any missing tarballs manually with
   the same staging tag, then promote each name to `latest` in dependency order
   from `scripts/release-package-order.mjs`.
3. Do **not** bump a patch version just to “fix” a partial publish — npm versions
   are immutable. Finish `X.Y.Z` on the registry, or yank only as a last resort
   after operator review.

**GitHub Release coupling:** the GitHub Release step runs only after staging
publish + `latest` promotion succeed, so consumers never see a GitHub Release for
a version whose CLI package is missing from `latest`.

## Publish Order

The release workflow publishes packages sequentially in the order from
`scripts/release-package-order.mjs`:

1. Core, persistence, contracts, output, config, targeting, UI, and parser
   substrate packages.
2. Language adapters.
3. First-party tool packages.
4. Graph adapter packages.
5. Fitness check packs.
6. `opensip-cli`.

Do not hand-edit package order in the workflow. Update
`scripts/release-package-order.mjs` and let the contract tests tell you which
surfaces need to change.

## Adding A Publishable Package

A new workspace package is not releasable until it is registered in the repo **and**
its npm **name** exists on the registry with a trusted publisher configured. OIDC
trusted publishing (what `.github/workflows/release.yml` uses) requires the
package to already exist on npm — there is no "pending trusted publisher" slot.

**Single source of truth:** `scripts/release-package-order.mjs`. The release
workflow, `bootstrap-publish.sh`, `release-preflight`, and
`verify-release` all derive from or verify against it. Do not hand-list packages
in `release.yml` or `bootstrap-publish.sh`.

### 1. Repo changes (before any npm publish)

1. **Create the workspace package** under `packages/`. Its `package.json` `name`
   must be `opensip-cli` or `@opensip-cli/*`, and it must **not** set
   `"private": true`. Include a `files` field (typically `["dist"]`), correct
   layer dependencies (dependency-cruiser enforces the DAG), and LICENSE/NOTICE
   (propagated from the repo root — see `pnpm licenses:sync` below).
2. **Add an entry** to `RELEASE_PACKAGE_ORDER` in
   `scripts/release-package-order.mjs` — correct **dependency/publish order**
   (downstream packages publish after their deps), plus `publishReason`, `dir`,
   and `filter`.
3. **Update this file (`RELEASING.md`)** — CI's release-package-order contract
   test enforces the prose:
   - Add a row to [The 38 packages](#the-38-packages) (update the section title
     count when the set size changes).
   - Add the unscoped name to the [npm verify loop](#cutting-a-release) `for p in …`
     block (scoped packages only; `opensip-cli` stays on its own line).
4. **Update other package-count prose** if the set size changed (e.g. `CLAUDE.md`,
   `docs/public/10-concepts/03-modular-monolith.md`). Run `pnpm docs:build` and
   commit `docs/web-generated/` if you edit `docs/public/`.
5. **Regenerate derived package metadata:**

   ```bash
   pnpm docs:readmes && pnpm docs:keywords && pnpm licenses:sync
   ```

6. **Verify the contract test:**

   ```bash
   pnpm test --filter opensip-cli -- release-package-order
   ```

### 2. One-time npm bootstrap (brand-new names only)

Trusted publishers can only be attached to a package **after** its name exists
on npm. Brand-new names are bootstrapped once with a **temporary granular token**.
The bootstrap publish ships **without provenance**; every subsequent version is
published by OIDC **with** provenance. Do **not** run bootstrap for a name that
already exists on npm at any version — that would publish the current version
without provenance and permanently block OIDC from re-publishing it (npm versions
are immutable).

**Operator roles:**

| Step | Who |
| ---- | --- |
| Create a short-lived granular npm token | Human |
| Run `bootstrap-publish.sh` | Human or agent (token via env var only) |
| Configure trusted publishing on npmjs.com | Human |
| Delete the npm token | Human |
| All future releases | Tag-driven OIDC (`release.yml`) |

**Token:** create a **granular access token** at npm → Account → Access Tokens
(scope `@opensip-cli/*`, publish permission). Provide it only in the shell
environment for the bootstrap run; never commit it or write it to a tracked
file.

```bash
NPM_TOKEN=npm_xxx ./scripts/bootstrap-publish.sh
```

The script reads the package list from `release-package-order.mjs --print names`,
packs each brand-new name at the current `packages/core/package.json#version`,
and publishes via `npm publish <tarball>`. Names already on the registry are
skipped (their next version is published by the OIDC release).

When bootstrap completes, configure **trusted publishing** for each package
marked **NEW** in the output:

| Field | Value |
| ----- | ----- |
| Organization | `opensip-ai` |
| Repository | `opensip-cli` |
| Workflow file | `release.yml` |
| Environment | *(leave empty)* |

Direct link pattern: `https://www.npmjs.com/package/<encoded-name>/access`
(e.g. `@opensip-cli/foo` → `%40opensip-cli%2Ffoo`).

**Delete the npm token** when OIDC is configured for every new name. Future
releases follow [Cutting A Release](#cutting-a-release) — no token required.

## Removing A Publishable Package

npm versions are **immutable**. Removal means: stop shipping the package from
this repo and **deprecate** it on the registry. Do not unpublish published
versions or bump a patch version to "fix" a mistaken publish — see
[Partial publish recovery](#partial-publish-recovery).

### 1. Repo changes

1. **Migrate or remove consumers** — workspace dependencies, tool registrations,
   and docs references.
2. **Retire the package** — delete its directory **or** set `"private": true` in
   its `package.json` (private packages are excluded from the publishable set).
3. **Remove its entry** from `scripts/release-package-order.mjs`.
4. **Update this file (`RELEASING.md`)** — remove the table row, decrement the
   stated package count in the section title, and remove the unscoped name from
   the npm-verify `for p in …` loop.
5. **Update other package-count prose** if the set size changed; regenerate web
   docs if `docs/public/` changed.
6. **Regenerate derived package metadata:**

   ```bash
   pnpm docs:readmes && pnpm docs:keywords && pnpm licenses:sync
   ```

7. **Verify:**

   ```bash
   pnpm test --filter opensip-cli -- release-package-order
   ```

   Before the next tag, run `pnpm release:preflight` as usual —
   `verify-release` check #10 fails if the order file and discovered workspace
   set diverge.

### 2. npm registry

Deprecate the retired package so consumers see a migration message:

```bash
npm deprecate @opensip-cli/<name>@'*' \
  "Package removed in opensip-cli vX.Y.Z — use <replacement>"
```

Document the removal in `CHANGELOG.md` under the release that stops shipping the
package.

## Data Store Changes

SQLite/Drizzle schema changes require a new migration under
`packages/datastore/migrations/`.

1. Change the schema.
2. Generate the migration.
3. Commit the migration with the schema change.
4. Never edit a previously committed migration file.

The CLI applies pending migrations automatically when opening the datastore.

`PRAGMA user_version` stores a **logical schema id** (`LOGICAL_SCHEMA_VERSION` in
`packages/datastore/src/schema-version.ts`), not the Drizzle journal entry count.
Bump the logical id only when squashing migrations or making an incompatible
rewrite — not on every additive migration. Users upgrading from v0.1.0 may see
their local `.runtime/` cache re-stamped once across the v0.1.0→v0.1.1 squash
boundary without deleting it.
