---
status: current
last_verified: 2026-05-18
release: v1.3.0
title: "Package catalog"
audience: [contributors, plugin-authors]
purpose: "Flat reference of every package in the monorepo: name, path, layer, one-line role, key exports. Lookup-only; the conceptual layer narrative lives in 10-mental-model/03-modular-monolith.md."
source-files:
  - packages/
  - pnpm-workspace.yaml
  - .dependency-cruiser.cjs
related-docs:
  - ../10-mental-model/03-modular-monolith.md
  - ../90-conventions/02-layer-policy.md
---
# Package catalog

Flat, lookup-shaped reference for every workspace package, grouped by layer. For the *why* behind the layers — what "kernel" means, the import-rule arrows, the worked example threading through them — see [`../10-mental-model/03-modular-monolith.md`](/docs/opensip-tools/10-mental-model/03-modular-monolith/).

## How to use this page

Find the package by name, click through to its source dir, then `src/index.ts` for the full export surface. The "Key exports" column lists the one to three grep-anchors most worth knowing — not the full API.

## Layer 1 — kernel

Pure types, registries, errors, IDs, logger, paths. No tool-specific knowledge.

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-tools/core` | `packages/core/` | Kernel — language adapters, plugin loader, errors, logger, IDs, retry, project config, Tool registry | `Tool`, `ToolRegistry`, `defaultToolRegistry`, `LanguageAdapter`, `defaultLanguageRegistry`, `Signal`, `createSignal`, `discoverPlugins`, `discoverToolPackages`, `resolveProjectPaths`, `resolveUserPaths`, `logger`, `ToolError`, `ValidationError` |

## Layer 2 — datastore and shared contract types

`@opensip-tools/datastore` is the SQLite + Drizzle persistence kernel; it sits between `core` and `contracts` and depends only on `core`. Tools own their domain schemas (sessions in contracts; baseline/catalog in graph; baseline in fitness). Adding a new tool means adding a new schema module — datastore is paradigm-agnostic infrastructure.

`@opensip-tools/contracts` defines the contract layer between Tools and the runner. Output shapes, exit codes, persistence helpers, dashboard generator. Imports `core` and `datastore` only.

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-tools/datastore` | `packages/datastore/` | SQLite + Drizzle persistence kernel — `DataStore` interface, factory, in-memory + on-disk backends, workspace migration store under `migrations/` | `DataStore`, `DataStoreFactory`, `DataStoreOpenOptions`, `DataStoreMigrationError` |
| `@opensip-tools/contracts` | `packages/contracts/` | Shared contract types — `CliOutput`/`CommandResult` shapes, exit codes, session persistence, dashboard generator | `CliOutput`, `CheckOutput`, `FindingOutput`, `CommandResult`, `EXIT_CODES`, `getErrorSuggestion`, `SessionRepo`, `StoredSession`, `generateDashboardHtml`, `GraphCatalog` |

## Layer 3 — tools and language adapters

Peer packages at the same layer. Tools implement the `Tool` contract; language adapters implement `LanguageAdapter`.

### Tools

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-tools/fitness` | `packages/fitness/engine/` | Fitness check engine, `defineCheck`, `defineRecipe`, gate, SARIF builder | `defineCheck`, `defineRecipe`, `FitnessRecipeService`, `defaultRecipeRegistry`, `getCheckConfig`, `executeFit`, `loadSignalersConfig`, `fitnessTool`, `saveBaseline`, `compareToBaseline`, `buildSarifLog`, `reportToCloud`, `openDashboard` |
| `@opensip-tools/simulation` | `packages/simulation/engine/` | Simulation engine, four scenario kinds | `defineLoadScenario`, `defineChaosScenario`, `defineInvariantScenario`, `defineFixEvaluationScenario`, `defineSimulationRecipe`, `simulationTool`, `defaultSimulationRecipeRegistry`, `SCENARIO_KINDS` |
| `@opensip-tools/graph` | `packages/graph/engine/` | Static call-graph + dead-end analysis, six-stage staged pipeline (discover → inventory → edges → indexes → rules → render). Language-pluggable as of v1.3.0: ships TypeScript, Python, and Rust adapters as internal subdirs (`lang-typescript/`, `lang-python/`, `lang-rust/`), all implementing the `GraphLanguageAdapter` contract under `lang-adapter/`. Imports SARIF helpers from `@opensip-tools/fitness` (peer-layer dep, DEC-3) | `graphTool`, `Catalog`, `FunctionOccurrence`, `CallEdge`, `Indexes`, `Rule`, `Renderer`, `GraphLanguageAdapter`, `registerAdapter`, `pickAdapter` |

### Language adapters

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-tools/lang-typescript` | `packages/languages/lang-typescript/` | TypeScript/JavaScript adapter — TS compiler API + query layer | `typescriptAdapter`, `filterContent`, `clearFilterCache` (re-exported from fitness) |
| `@opensip-tools/lang-rust` | `packages/languages/lang-rust/` | Rust adapter — strip routines + line-offset metadata (tree-sitter integration deferred) | `rustAdapter` |
| `@opensip-tools/lang-python` | `packages/languages/lang-python/` | Python adapter — strip routines | `pythonAdapter` |
| `@opensip-tools/lang-java` | `packages/languages/lang-java/` | Java adapter — strip routines | `javaAdapter` |
| `@opensip-tools/lang-go` | `packages/languages/lang-go/` | Go adapter — strip routines | `goAdapter` |
| `@opensip-tools/lang-cpp` | `packages/languages/lang-cpp/` | C/C++ adapter — strip routines | `cppAdapter` |

## Layer 4 — fitness check packs

Each pack ships `checks: Check[]`, `checkDisplay`, and `metadata`. Discovered by name prefix (`@opensip-tools/checks-*`) when installed, or by explicit pinning in `plugins.checkPackages:` for arbitrary scopes.

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-tools/checks-universal` | `packages/fitness/checks-universal/` | Cross-language checks (text/regex/file shape) | `checks`, `checkDisplay`, `metadata`, plus per-check named exports |
| `@opensip-tools/checks-typescript` | `packages/fitness/checks-typescript/` | TypeScript/Node.js checks | `checks`, `checkDisplay`, `metadata` |
| `@opensip-tools/checks-python` | `packages/fitness/checks-python/` | Python checks | `checks`, `checkDisplay`, `metadata` |
| `@opensip-tools/checks-java` | `packages/fitness/checks-java/` | Java checks | `checks`, `checkDisplay`, `metadata` |
| `@opensip-tools/checks-go` | `packages/fitness/checks-go/` | Go checks | `checks`, `checkDisplay`, `metadata` |
| `@opensip-tools/checks-cpp` | `packages/fitness/checks-cpp/` | C/C++ checks (clang-tidy backed) | `checks`, `checkDisplay`, `metadata` |

## Layer 5 — composition root

Imports every layer below. The published binary.

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-tools/cli` | `packages/cli/` | The `opensip-tools` command-line binary; argv parsing, Tool registration, top-level commands | `bin/opensip-tools`, `decideOpen`, `launchBrowser`, `printWelcome`, `executeUninstall`, `getErrorSuggestion` (re-export) |

## Adding a new package

1. **Decide the layer.** Apply the rules in [`../10-mental-model/03-modular-monolith.md`](/docs/opensip-tools/10-mental-model/03-modular-monolith/): kernel = zero tool knowledge; contracts = used by every tool; tools = own a Tool contract; language adapters = implement `LanguageAdapter`; check packs = ship `Check[]`; cli = composition root only.
2. **Add the dep-cruiser carve-out** if needed. The default layer rules forbid most cross-layer edges; if your package needs an exception, add it to [`.dependency-cruiser.cjs`](https://github.com/opensip-ai/opensip-tools/blob/v2.0.0/.dependency-cruiser.cjs) and document it in [`../90-conventions/02-layer-policy.md`](/docs/opensip-tools/90-conventions/02-layer-policy/).
3. **Add a row** in the right table above with the canonical npm name, path, one-line role (concrete, not "fitness concerns"), and 1–3 key exports a reader would grep for.
4. **Update the layer narrative** in `10-mental-model/03-modular-monolith.md` if the new package changes what the layer *means*. Pure additions to an existing pattern don't need a narrative edit — just the row here.

---

## Verification trail

Last verified at v1.3.0 against:

- `packages/` directory listing (18 packages — 1 kernel + 1 contracts + 6 lang + 1 fitness + 1 simulation + 1 graph + 6 check packs + 1 cli). v1.3.0 added Python and Rust **graph** adapters as internal subdirs of `@opensip-tools/graph` (`lang-python/`, `lang-rust/`); the published-package count is unchanged. The fitness `lang-python` / `lang-rust` packages at Layer 3 are unrelated siblings — see [`60-subsystems/01-language-adapters.md`](/docs/opensip-tools/60-subsystems/01-language-adapters/) for the `LanguageAdapter` vs. `GraphLanguageAdapter` distinction.
- Each package's `package.json` `description` and `name` field, read directly.
- The dep-cruiser config for layer rules.
