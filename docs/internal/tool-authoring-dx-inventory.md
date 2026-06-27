---
status: current
last_verified: 2026-06-26
owner: opensip-cli
---

# Tool authoring DX inventory (Plan 05)

Evidence source for scaffold templates, manifest validation, trust posture, and
recipe listing differences.

## Authored tool forms

| Form | Discovery path | Trust posture | Admission |
|------|----------------|---------------|-----------|
| Project-local sidecar | `<project>/opensip-cli/tools/<id>/opensip-tool.manifest.json` | Deny-by-default; `OPENSIP_CLI_ALLOW_PROJECT_TOOLS` | `admitProjectLocalTool` |
| User-global sidecar | `~/.opensip-cli/tools/<id>/` (via `resolveUserPaths`) | Trusted-by-default (user placed it) | `admitUserGlobalTool` |
| Installed npm package | `package.json#opensipTools` under `node_modules` | Deny-by-default; `OPENSIP_CLI_ALLOW_INSTALLED_TOOLS` | Marker discovery + trust gate |

Project-local trust is evaluated before runtime import (`register-authored-tools.ts`,
`tool-trust.ts`). Wildcard `'*'` is warned but supported.

## Current scaffold outputs (`tools create`)

### `minimal-js` (default)

| File | Purpose |
|------|---------|
| `opensip-tool.manifest.json` | Sidecar manifest (`identity`, `stableId`, `apiVersion`, commands) |
| `index.mjs` | Dependency-free runtime plain object |

### `ts-local`

| File | Purpose |
|------|---------|
| `opensip-tool.manifest.json` | Sidecar manifest (`main: ./dist/index.js`) |
| `package.json` | Private ESM package with `build` / `test` / `validate` scripts |
| `tsconfig.json` | ESM output to `dist/` |
| `src/index.ts` | `createTool()` primary command |
| `src/index.test.ts` | Asserts metadata/commands; no extension hooks |
| `README.md` | Build, validate, allowlist guidance |

`tools create` writes files only — no install, build, or trust activation.

## Template compatibility contract

Plan 03 (ADR-0074) is landed. Templates emit bounded integer plugin epochs via
`apiVersion` (not transitional closed per-tool manifest fields).

| Template | `kind` | Required manifest fields | Runtime entry | Notes |
|----------|--------|--------------------------|---------------|-------|
| `minimal-js` | `tool` | `id`, `identity`, `stableId`, `name`, `version`, `apiVersion`, `main`, `commands` | `./index.mjs` | Zero-dependency smoke path |
| `ts-local` | `tool` | Same as minimal-js; `main: ./dist/index.js` | Built `dist/index.js` | Uses `@opensip-cli/core` `createTool()` |

Shared rules:

- `identity.name` equals `id` and primary command name.
- `stableId` is a generated UUID; runtime `metadata.id` uses it.
- `apiVersion` is `PLUGIN_API_VERSION` (currently `1`).
- No implicit `extensionPoints` in generated sources.

Historical drift (fixed by Plan 05): older scaffolds omitted `identity` while
`validateManifest` requires it.

## Validation substrate

Authors use `opensip tools validate <dir>` (optional `--install-deps` for typed
packages). Static admission uses `loadToolManifest` + `validateManifest`; runtime
coherence uses `assertManifestMatchesTool`; execution uses the child-process
runtime probe.

## Public author test kit

`@opensip-cli/tool-test-kit` is a publishable support package for third-party
Tool authors. It exposes in-memory `RunScope` helpers, a `ToolCliContext` double
including `reportFailure` and `writeArtifact`, and assertion helpers for command
results / signal envelopes. It depends only on `@opensip-cli/core` and
`@opensip-cli/contracts`; it must not import the CLI composition root.

Workspace-private `@opensip-cli/test-support` delegates generic scope/context
helpers to the public kit and keeps only repository-specific fixtures such as
fitness-check harnesses.

## Recipe listing differences

Shared result shape: `ListRecipesResult` (`list-history-results.ts`). Neutral
`selectionLabel` is preferred; `checkCount` remains for staged JSON compatibility.

| Tool | Selector field | Label vocabulary | Domain-owned semantics |
|------|----------------|------------------|------------------------|
| Fitness | `recipe.checks` | `all checks`, `N checks`, `pattern-based` | Check execution, retry, timeout |
| Graph | `recipe.rules` | `all rules`, `N rules`, `pattern-based` | Rule selection only (no execution block) |
| Simulation | built-in flag | `built-in`, `user-defined` | Scenario execution, sim-only selector arms |

Shared projection: `recipeDisplayInfo(recipe, selectionLabel)` in
`packages/core/src/recipes/display.ts`. Selector resolution and execution stay in
each tool package.

## Extension taxonomy (author/operator)

| Extension kind | Discovery | Trust | Typical authoring path |
|----------------|-----------|-------|------------------------|
| Bundled whole tools | Built-in manifests | Trusted (shipped) | First-party `defineTool` in engine packages |
| Installed whole tools | `node_modules` marker | Allowlist opt-in | `opensip tools install` |
| Project-local authored tools | `opensip-cli/tools/<id>/` | Deny-by-default | `opensip tools create` |
| User-global authored tools | `~/.opensip-cli/tools/` | Trusted-by-default | Manual sidecar + runtime |
| Fit packs / recipes | `plugins.fit` layout | Pack epoch compatibility | `defineCheck` / recipe modules |
| Sim packs / recipes | `plugins.sim` layout | Pack epoch compatibility | Scenario + recipe modules |
| Graph adapters / recipes | `plugins.graph` layout | Pack epoch compatibility | Adapter modules |
| Loose project-local files | Project plugin dirs | Executable when loaded | Direct `.mjs` in plugin paths |

See ADR-0061 (trust tiers) and ADR-0076 (helper/template boundary).
