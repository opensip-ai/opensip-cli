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

## Cutting A Release

1. Bump versions for every publishable package and the root package:

   ```bash
   node -e "const fs=require('fs');const {execSync}=require('child_process');const v=process.argv[1];const files=['package.json',...execSync('rg --files -g package.json packages').toString().trim().split('\n')];for(const f of files){const p=JSON.parse(fs.readFileSync(f,'utf8'));if(p.name==='opensip-cli'||p.name==='@opensip-cli/root'||p.name?.startsWith('@opensip-cli/')){p.version=v;fs.writeFileSync(f,JSON.stringify(p,null,2)+'\n');}}" 1.0.0
   pnpm install --lockfile-only
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
   pnpm verify-release --expected-version v1.0.0
   ```

4. Commit, tag, and push:

   ```bash
   git commit -am "chore: release 1.0.0"
   git tag v1.0.0
   git push origin main v1.0.0
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
