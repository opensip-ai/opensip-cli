---
status: current
last_verified: 2026-05-26
release: v2.0.0
title: "Package catalog"
audience: [contributors, plugin-authors]
purpose: "Flat reference of every package in the monorepo: name, path, layer, one-line role, key exports. Lookup-only; the conceptual layer narrative lives in 10-concepts/03-modular-monolith.md."
source-files:
  - packages/
  - pnpm-workspace.yaml
  - .dependency-cruiser.cjs
related-docs:
  - ../10-concepts/03-modular-monolith.md
  - ../80-implementation/05-layer-policy.md
---
# Package catalog

Flat, lookup-shaped reference for every workspace package, grouped by layer. For the *why* behind the layers — what "kernel" means, the import-rule arrows, the worked example threading through them — see [`../10-concepts/03-modular-monolith.md`](../10-concepts/03-modular-monolith.md).

## How to use this page

Find the package by name, click through to its source dir, then `src/index.ts` for the full export surface. The "Key exports" column lists the one to three grep-anchors most worth knowing — not the full API.

## Layer 1 — kernel

Pure types, registries, errors, IDs, logger, paths. No tool-specific knowledge.

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-tools/core` | `packages/core/` | Kernel — language adapters, plugin loader, errors, logger, IDs, retry, project config, per-invocation execution scope | `Tool`, `ToolRegistry`, `LanguageAdapter`, `LanguageRegistry`, `RunScope`, `runWithScope`, `currentScope`, `Registry`, `Signal`, `createSignal`, `discoverPlugins`, `discoverToolPackages`, `resolveProjectPaths`, `resolveUserPaths`, `logger`, `ToolError`, `ValidationError` |

## Layer 2 — datastore and shared contract types

`@opensip-tools/datastore` is the SQLite + Drizzle persistence kernel; it sits between `core` and `contracts` and depends only on `core`. Tools own their domain schemas (sessions in contracts; baseline/catalog in graph; baseline in fitness). Adding a new tool means adding a new schema module — datastore is paradigm-agnostic infrastructure.

`@opensip-tools/contracts` defines the contract layer between Tools and the runner. Output shapes, exit codes, persistence helpers, dashboard generator. Imports `core` and `datastore` only.

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-tools/datastore` | `packages/datastore/` | SQLite + Drizzle persistence kernel — `DataStore` interface, factory, in-memory + on-disk backends, workspace migration store under `migrations/` | `DataStore`, `DataStoreFactory`, `DataStoreOpenOptions`, `DataStoreMigrationError` |
| `@opensip-tools/contracts` | `packages/contracts/` | Shared contract types — `CliOutput`/`CommandResult` shapes, exit codes, session persistence, dashboard generator | `CliOutput`, `CheckOutput`, `FindingOutput`, `CommandResult`, `EXIT_CODES`, `getErrorSuggestion`, `SessionRepo`, `StoredSession`, `generateDashboardHtml`, `GraphCatalog` |

## Layer 3 — tools, shared libraries, and language adapters

Peer packages at the same layer. Tools implement the `Tool` contract; shared libraries are consumed by Tools but don't implement the contract themselves; language adapters implement `LanguageAdapter`.

### Tools

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-tools/fitness` | `packages/fitness/engine/` | Fitness check engine, `defineCheck`, `defineRecipe`, gate, SARIF builder | `defineCheck`, `defineRecipe`, `FitnessRecipeService`, `defaultRecipeRegistry`, `getCheckConfig`, `executeFit`, `loadSignalersConfig`, `fitnessTool`, `saveBaseline`, `compareToBaseline`, `buildSarifLog`, `reportToCloud`, `openDashboard` |
| `@opensip-tools/simulation` | `packages/simulation/engine/` | Simulation engine, four scenario kinds | `defineLoadScenario`, `defineChaosScenario`, `defineInvariantScenario`, `defineFixEvaluationScenario`, `defineSimulationRecipe`, `simulationTool`, `currentSimulationRecipeRegistry`, `SCENARIO_KINDS` |
| `@opensip-tools/graph` | `packages/graph/engine/` | Static call-graph + dead-end analysis kernel. Six-stage staged pipeline (discover → inventory → edges → indexes → rules → render). Language-agnostic — adapters live in their own publishable packages (see "Graph language adapters" below) and register through `registerAdapter`. Imports SARIF helpers from `@opensip-tools/fitness` (peer-layer dep, DEC-3) | `graphTool`, `Catalog`, `FunctionOccurrence`, `CallEdge`, `Indexes`, `Rule`, `Renderer`, `GraphLanguageAdapter`, `registerAdapter`, `pickAdapter` |

### Shared libraries

Used by Tools but not Tools themselves — no `Tool` contract, no CLI subcommand. Peer-layer deps so a Tool can pull in just the library surface it needs.

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-tools/dashboard` | `packages/dashboard/` | Self-contained HTML dashboard generator — renders the fit/sim/graph report from session data + graph catalogs. Consumed by fitness's `dashboard` command and the auto-open hook. | `generateDashboardHtml` |
| `@opensip-tools/cli-ui` | `packages/cli-ui/` | Shared Ink/React presentational primitives — Banner, Spinner, RunHeader, theme. Extracted from `cli/` so tools that ship a live view depend on the UI kit without pulling in the dispatcher. | `Banner`, `Spinner`, `RunHeader`, `theme` |

### Language adapters (fitness — six languages)

Implement `LanguageAdapter`. Used by fitness checks and any future tool that needs per-language strip/parse routines.

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-tools/lang-typescript` | `packages/languages/lang-typescript/` | TypeScript/JavaScript adapter — TS compiler API + query layer | `typescriptAdapter`, `filterContent`, `clearFilterCache` |
| `@opensip-tools/lang-rust` | `packages/languages/lang-rust/` | Rust adapter — strip routines + line-offset metadata | `rustAdapter` |
| `@opensip-tools/lang-python` | `packages/languages/lang-python/` | Python adapter — strip routines | `pythonAdapter` |
| `@opensip-tools/lang-java` | `packages/languages/lang-java/` | Java adapter — strip routines | `javaAdapter` |
| `@opensip-tools/lang-go` | `packages/languages/lang-go/` | Go adapter — strip routines | `goAdapter` |
| `@opensip-tools/lang-cpp` | `packages/languages/lang-cpp/` | C/C++ adapter — strip routines | `cppAdapter` |

### Graph language adapters (five languages)

Distinct from the fitness language adapters above — these implement the graph engine's `GraphLanguageAdapter` contract (catalog inventory, edge extraction). Each is a publishable npm package marked with `opensipTools.kind: "graph-adapter"` and registered via `registerAdapter` when imported.

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-tools/graph-typescript` | `packages/graph/graph-typescript/` | TypeScript graph adapter — symbol-resolved call graph via TS compiler API | `typescriptGraphAdapter` |
| `@opensip-tools/graph-python` | `packages/graph/graph-python/` | Python graph adapter — tree-sitter backed | `pythonGraphAdapter` |
| `@opensip-tools/graph-rust` | `packages/graph/graph-rust/` | Rust graph adapter — tree-sitter backed | `rustGraphAdapter` |
| `@opensip-tools/graph-go` | `packages/graph/graph-go/` | Go graph adapter — tree-sitter backed | `goGraphAdapter` |
| `@opensip-tools/graph-java` | `packages/graph/graph-java/` | Java graph adapter — tree-sitter backed | `javaGraphAdapter` |

## Layer 4 — fitness check packs

Each pack ships `checks: Check[]`, `checkDisplay`, and `metadata`. Discovered via three complementary paths: name-prefix scan under default + configured `plugins.packageScopes`, `opensipTools.kind: "fit-pack"` marker (scope-independent), or explicit pinning in `plugins.checkPackages:`. See [`80-implementation/02-plugin-loader.md`](../80-implementation/02-plugin-loader.md) for the resolution rules.

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-tools/checks-universal` | `packages/fitness/checks-universal/` | Cross-language checks (text/regex/file shape) | `checks`, `checkDisplay`, `metadata`, plus per-check named exports |
| `@opensip-tools/checks-typescript` | `packages/fitness/checks-typescript/` | TypeScript/Node.js checks | `checks`, `checkDisplay`, `metadata` |
| `@opensip-tools/checks-python` | `packages/fitness/checks-python/` | Python checks | `checks`, `checkDisplay`, `metadata` |
| `@opensip-tools/checks-java` | `packages/fitness/checks-java/` | Java checks | `checks`, `checkDisplay`, `metadata` |
| `@opensip-tools/checks-go` | `packages/fitness/checks-go/` | Go checks | `checks`, `checkDisplay`, `metadata` |
| `@opensip-tools/checks-cpp` | `packages/fitness/checks-cpp/` | C/C++ checks (clang-tidy backed) | `checks`, `checkDisplay`, `metadata` |
| `@opensip-tools/checks-rust` | `packages/fitness/checks-rust/` | Rust checks | `checks`, `checkDisplay`, `metadata` |

## Layer 5 — composition root

Imports every layer below. The published binary.

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-tools/cli` | `packages/cli/` | The `opensip-tools` command-line binary; argv parsing, Tool registration, top-level commands | `bin/opensip-tools`, `decideOpen`, `launchBrowser`, `printWelcome`, `executeUninstall`, `getErrorSuggestion` (re-export) |

## Adding a new package

1. **Decide the layer.** Apply the rules in [`../10-concepts/03-modular-monolith.md`](../10-concepts/03-modular-monolith.md): kernel = zero tool knowledge; contracts = used by every tool; tools = own a Tool contract; language adapters = implement `LanguageAdapter`; check packs = ship `Check[]`; cli = composition root only.
2. **Add the dep-cruiser carve-out** if needed. The default layer rules forbid most cross-layer edges; if your package needs an exception, add it to [`.dependency-cruiser.cjs`](../../../.dependency-cruiser.cjs) and document it in [`../80-implementation/05-layer-policy.md`](../80-implementation/05-layer-policy.md).
3. **Add a row** in the right table above with the canonical npm name, path, one-line role (concrete, not "fitness concerns"), and 1–3 key exports a reader would grep for.
4. **Update the layer narrative** in `10-concepts/03-modular-monolith.md` if the new package changes what the layer *means*. Pure additions to an existing pattern don't need a narrative edit — just the row here.

---

## Verification trail

Last verified at v2.0.0 against:

- `packages/` directory listing — **27 publishable packages** total:
  - Layer 1 (kernel): 1 — `core`
  - Layer 2 (datastore + contracts): 2 — `datastore`, `contracts`
  - Layer 3 Tools: 3 — `fitness`, `simulation`, `graph`
  - Layer 3 Shared libraries: 2 — `dashboard`, `cli-ui`
  - Layer 3 Fitness language adapters: 6 — `lang-typescript`, `lang-rust`, `lang-python`, `lang-java`, `lang-go`, `lang-cpp`
  - Layer 3 Graph language adapters: 5 — `graph-typescript`, `graph-python`, `graph-rust`, `graph-go`, `graph-java`
  - Layer 4 (check packs): 7 — `checks-universal`, `checks-typescript`, `checks-python`, `checks-java`, `checks-go`, `checks-cpp`, `checks-rust`
  - Layer 5 (composition root): 1 — `cli`
- v2.0.0 promoted graph language adapters from internal subdirs to publishable npm packages (`@opensip-tools/graph-*`), added `checks-rust` to the bundled check packs, and split `dashboard` and `cli-ui` into peer-layer libraries to keep Tool engines free of UI-kit and rendering dependencies. The fitness language adapters (`@opensip-tools/lang-*`) and the graph language adapters (`@opensip-tools/graph-*`) are unrelated siblings implementing different contracts (`LanguageAdapter` vs. `GraphLanguageAdapter`) — see [`50-extend/05-language-adapters.md`](../50-extend/05-language-adapters.md) for the distinction.
- Each package's `package.json` `description` and `name` field, read directly.
- The dep-cruiser config for layer rules.
