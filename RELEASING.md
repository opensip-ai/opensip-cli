# Releasing

Releases are tag-driven. Pushing a tag matching `v*` triggers
`.github/workflows/release.yml`, which builds, tests, packs, and publishes the
workspace packages to npm with OIDC trusted publishing.

The user-facing npm package is `opensip-cli`. It installs the `opensip` command.

## The 33 packages

`scripts/release-package-order.mjs` is the source of truth for the publishable
package set and dependency order. The release workflow, bootstrap script, and
contract tests derive from or verify against that source.

| Layer | Package | Path |
| ----- | ------- | ---- |
| Kernel | `@opensip-cli/core` | `packages/core` |
| Persistence | `@opensip-cli/datastore` | `packages/datastore` |
| Shared CLI | `@opensip-cli/contracts` | `packages/contracts` |
| Persistence | `@opensip-cli/session-store` | `packages/session-store` |
| Output | `@opensip-cli/output` | `packages/output` |
| Config | `@opensip-cli/config` | `packages/config` |
| Targeting | `@opensip-cli/targeting` | `packages/targeting` |
| Shared CLI | `@opensip-cli/cli-ui` | `packages/cli-ui` |
| Languages | `@opensip-cli/tree-sitter` | `packages/tree-sitter` |
| Languages | `@opensip-cli/lang-typescript` | `packages/languages/lang-typescript` |
| Languages | `@opensip-cli/lang-rust` | `packages/languages/lang-rust` |
| Languages | `@opensip-cli/lang-python` | `packages/languages/lang-python` |
| Languages | `@opensip-cli/lang-go` | `packages/languages/lang-go` |
| Languages | `@opensip-cli/lang-java` | `packages/languages/lang-java` |
| Languages | `@opensip-cli/lang-cpp` | `packages/languages/lang-cpp` |
| Tools | `@opensip-cli/dashboard` | `packages/dashboard` |
| Tools | `@opensip-cli/fitness` | `packages/fitness/engine` |
| Tools | `@opensip-cli/simulation` | `packages/simulation/engine` |
| Tools | `@opensip-cli/graph` | `packages/graph/engine` |
| Graph adapters | `@opensip-cli/graph-adapter-common` | `packages/graph/graph-adapter-common` |
| Graph adapters | `@opensip-cli/graph-typescript` | `packages/graph/graph-typescript` |
| Graph adapters | `@opensip-cli/graph-python` | `packages/graph/graph-python` |
| Graph adapters | `@opensip-cli/graph-rust` | `packages/graph/graph-rust` |
| Graph adapters | `@opensip-cli/graph-go` | `packages/graph/graph-go` |
| Graph adapters | `@opensip-cli/graph-java` | `packages/graph/graph-java` |
| Check packs | `@opensip-cli/checks-universal` | `packages/fitness/checks-universal` |
| Check packs | `@opensip-cli/checks-typescript` | `packages/fitness/checks-typescript` |
| Check packs | `@opensip-cli/checks-python` | `packages/fitness/checks-python` |
| Check packs | `@opensip-cli/checks-go` | `packages/fitness/checks-go` |
| Check packs | `@opensip-cli/checks-java` | `packages/fitness/checks-java` |
| Check packs | `@opensip-cli/checks-cpp` | `packages/fitness/checks-cpp` |
| Check packs | `@opensip-cli/checks-rust` | `packages/fitness/checks-rust` |
| CLI | `opensip-cli` (unscoped) | `packages/cli` |

All publishable packages share the same version. The release workflow publishes
them in dependency order, with `opensip-cli` last.

## Version Surfaces (what a bump touches)

The product version has **one source of truth** —
`packages/core/package.json#version` — and fans out to three kinds of surface.
The mechanical sweep is automated by **`scripts/bump-version.mjs`** (with a
`--check` drift guard); this section explains what it touches so the manual
parts are obvious. (`git grep -n '<old-version>'` after a bump is the backstop.)

### 1. Version fields (hand-set, lockstep)

All 33 publishable packages **plus** the private root (`@opensip-cli/root`) and
the private `@opensip-cli/test-support` carry one shared version — 35
`package.json` files. The bump script matches `name === 'opensip-cli'`,
`name === '@opensip-cli/root'`, or `name.startsWith('@opensip-cli/')`. Fixture
packages use other scopes (`@fixture/*`, `@example/*`, `@medium/*`,
`@opensip-cli-fixture/*`, bare names) and are deliberately **not** touched.

Internal dependencies all use `workspace:*`, so `pnpm pack` rewrites them to the
concrete version at publish time. **A bump never edits dependency specifiers.**
Refresh the lockfile afterward with `pnpm install --lockfile-only`.

### 2. Derived surfaces (DO NOT hand-edit — regenerate)

Each reads `packages/core/package.json#version`:

| Surface | Regenerate with | Pins |
| ------- | --------------- | ---- |
| CLI `--version` | nothing — `readPackageVersion` walks to the nearest `package.json` at runtime | the installed version |
| Per-package `README.md` (×33) | `pnpm docs:readmes` | `tree/vX.Y.Z/…` source + catalog links |
| `docs/web-generated/**` + `manifest.json` | `pnpm docs:build` | `blob/vX.Y.Z/…` links; manifest `version` / `rawBase` |

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
crossing the `1.0` boundary — the **peer-dependency *guidance* prose** ("pin to
the 0.x line" vs. "pin to majors"; a `^0.y` caret locks to the minor). Example
third-party plugin/pack `"version"` fields in `docs/public` are the *example's
own* version (independent of opensip-cli) and are intentionally left alone.

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
   node scripts/bump-version.mjs <new-version>   # 35 package.json + docs + SECURITY + prose
   pnpm install --lockfile-only                  # refresh the lockfile
   pnpm docs:readmes && pnpm docs:build          # regenerate version-pinned READMEs + web docs
   node scripts/bump-version.mjs --check         # assert no surface drifted
   ```

2. Update `CHANGELOG.md` with the release entry.

3. Run the local preflight:

   ```bash
   pnpm install
   pnpm build
   pnpm typecheck
   pnpm test
   pnpm docs:build
   pnpm docs:check
   pnpm verify-release --expected-version v0.1.0
   ```

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
   for p in core datastore contracts session-store output config targeting cli-ui tree-sitter \
            lang-typescript lang-rust lang-python lang-go lang-java lang-cpp \
            dashboard fitness simulation graph graph-adapter-common graph-typescript \
            graph-python graph-rust graph-go graph-java checks-universal checks-typescript \
            checks-python checks-go checks-java checks-cpp checks-rust; do
     printf '%-40s %s\n' "@opensip-cli/$p" "$(npm view "@opensip-cli/$p" version 2>/dev/null || echo MISSING)"
   done
   printf '%-40s %s\n' "opensip-cli" "$(npm view opensip-cli version 2>/dev/null || echo MISSING)"
   ```

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

## Bootstrapping A New Package

New npm package names need trusted publishing enabled before the tag-driven
release can publish them.

1. Create the package in npm with provenance/trusted publishing enabled for the
   release workflow.
2. Add it to `scripts/release-package-order.mjs`.
3. Add it to the table and verification loop above.
4. Run `pnpm test --filter opensip-cli -- release-package-order`.

## Data Store Changes

SQLite/Drizzle schema changes require a new migration under
`packages/datastore/migrations/`.

1. Change the schema.
2. Generate the migration.
3. Commit the migration with the schema change.
4. Never edit a previously committed migration file.

The CLI applies pending migrations automatically when opening the datastore.
