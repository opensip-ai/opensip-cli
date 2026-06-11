---
status: current
last_verified: 2026-06-11
release: v3.0.0
title: "Package catalog"
audience: [contributors, plugin-authors]
purpose: "Flat reference of every package in the monorepo: name, path, layer, one-line role, key exports. Lookup-only; the conceptual layer narrative lives in 10-concepts/03-modular-monolith.md."
source-files:
  - packages/
  - pnpm-workspace.yaml
  - .config/dependency-cruiser.cjs
related-docs:
  - ../10-concepts/03-modular-monolith.md
  - ../80-implementation/05-layer-policy.md
---
# Package catalog

Flat, lookup-shaped reference for every workspace package, grouped by layer. For the *why* behind the layers — what "kernel" means, the import-rule arrows, the worked example threading through them — see [`../10-concepts/03-modular-monolith.md`](/docs/opensip-tools/10-concepts/03-modular-monolith/).

## How to use this page

Find the package by name, click through to its source dir, then `src/index.ts` for the full export surface. The "Key exports" column lists the one to three grep-anchors most worth knowing — not the full API.

## Layer 1 — kernel

Pure types, registries, errors, IDs, logger, paths. No tool-specific knowledge.

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-tools/core` | `packages/core/` | Kernel — language adapters, plugin loader, errors, logger, IDs, retry, project config, per-invocation execution scope | `Tool`, `ToolRegistry`, `LanguageAdapter`, `LanguageRegistry`, `RunScope`, `runWithScope`, `currentScope`, `Registry`, `Signal`, `createSignal`, `discoverPlugins`, `discoverToolPackages`, `resolveProjectPaths`, `resolveUserPaths`, `logger`, `ToolError`, `ValidationError` |

## Layer 2 — datastore, contracts, tree-sitter, and cli-ui

`@opensip-tools/datastore` is the SQLite + Drizzle persistence kernel; it sits between `core` and the rest of this layer and depends only on `core`. Tools and `session-store` own their domain schemas (sessions in session-store; baseline/catalog in graph; baseline in fitness). Adding a new tool means adding a new schema module — datastore is paradigm-agnostic infrastructure.

`@opensip-tools/contracts` defines the contract layer between Tools and the runner — the `SignalEnvelope` output shape every tool returns, exit codes, the cross-tool `StoredSession` type, and the `GraphCatalog` surface. A types-and-constants package (no runtime persistence or rendering). Imports `core` only.

`@opensip-tools/tree-sitter` is the grammar-agnostic tree-sitter substrate (ADR-0010): the `web-tree-sitter` lifecycle (parser init/load) plus grammar-agnostic node accessors. Like `datastore` it imports `core` only (plus `web-tree-sitter`) and sits below the adapters that consume it — the fitness `lang-*` adapters and the four tree-sitter `graph-*` adapters (via `graph-adapter-common`) share it so the WASM lifecycle and node-walking helpers live in exactly one place. A dependency-cruiser rule (`tree-sitter-imports-core-only`) pins it to that substrate position.

`@opensip-tools/cli-ui` is the shared Ink/React presentational substrate (`Banner`, `Spinner`, `RunHeader`, `theme`). It is intentionally below tools so a tool with a live view can render with the common UI kit without depending on the CLI composition root.

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-tools/datastore` | `packages/datastore/` | SQLite + Drizzle persistence kernel — `DataStore` interface, factory, in-memory + on-disk backends, workspace migration store under `migrations/`, `user_version` schema-stamp guard | `DataStore`, `DataStoreFactory`, `DataStoreOpenOptions`, `DataStoreMigrationError`, `DataStoreVersionError` |
| `@opensip-tools/contracts` | `packages/contracts/` | Shared contract types — the `SignalEnvelope`/`CommandResult` shapes, exit codes, the cross-tool `StoredSession` type, `GraphCatalog` surface | `SignalEnvelope`, `RunVerdict`, `UnitResult`, `buildSignalEnvelope`, `CommandResult`, `EXIT_CODES`, `getErrorSuggestion`, `StoredSession`, `GraphCatalog` |
| `@opensip-tools/tree-sitter` | `packages/tree-sitter/` | Grammar-agnostic `web-tree-sitter` substrate (ADR-0010) — WASM parser lifecycle + node accessors, shared by the fitness `lang-*` and graph tree-sitter adapters. Depends on `web-tree-sitter` (and `core`) only | `createParser`, `parseToTree`, `walkNodes`, `findEnclosing`, `nameOf`, `childrenOf`, `namedChildrenOf`, `nodeText` |
| `@opensip-tools/cli-ui` | `packages/cli-ui/` | Shared Ink/React presentational primitives — Banner, Spinner, RunHeader, theme. Extracted from `cli/` so tools that ship a live view depend on the UI kit without pulling in the dispatcher. | `Banner`, `Spinner`, `RunHeader`, `theme` |

## Layer 3 — config, session/output/dashboard libraries, and fitness language adapters

Packages above the substrate, below tool engines. These are shared libraries consumed by the CLI and tools but not tools themselves; fitness language adapters implement `LanguageAdapter`.

### Shared libraries

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-tools/config` | `packages/config/` | Project-config schema composer and document loaders — validates host-owned blocks plus tool-contributed namespaces as one strict document before dispatch | `composeProjectConfigSchema`, `registerConfigSchema`, `loadProjectConfig`, `loadCliDefaults`, `projectConfigSchema` |
| `@opensip-tools/session-store` | `packages/session-store/` | Session persistence — `SessionRepo` runtime over the (package-internal) `sessions`/`session_tool_payload` schema, session-id helpers. Depends on `core`, `datastore`, `contracts` | `SessionRepo`, `SessionListOptions`, `generateSessionId`, `sanitizeForFilename` |
| `@opensip-tools/output` | `packages/output/` | Machine output layer (renamed from `@opensip-tools/reporting`, ADR-0011): pure `format/` formatters + effectful `sink/` delivery. Depends on `core`, `contracts` | `formatSignalJson`, `formatSignalSarif`, `buildOpenSipSarif`, `formatSignalTableRows`, `formatSignalTableSummary`, `Formatter`, `postChunked`, `createCloudSignalSink`, `resolveSignalSink`, `resolveRepoIdentity`, `checkEntitlement` |
| `@opensip-tools/dashboard` | `packages/dashboard/` | Self-contained HTML dashboard generator — renders the fit/sim/graph report from session data + graph catalogs. Consumed by the CLI-owned `dashboard` command and each tool's auto-open hook. | `generateDashboardHtml` |

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

## Layer 4 — tools

Tool engines implement the `Tool` contract. They are peer domains: none imports another tool or the CLI.

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-tools/fitness` | `packages/fitness/engine/` | Fitness check engine, `defineCheck`, `defineRecipe`, gate. Returns a `SignalEnvelope`; SARIF/cloud egress is owned by the composition root (ADR-0011). The engine, recipe service, registries, gate/baseline primitives, and CLI handlers are package-internal (curated barrel, ADR-0013) — locked by `public-api.test.ts` | `defineCheck`, `defineRecipe`, `getCheckConfig`, `fitnessTool` (+ the AST/text authoring helpers: `isTestFile`, `stripStringsAndComments`, `extractSnippet`, …) |
| `@opensip-tools/simulation` | `packages/simulation/engine/` | Simulation engine, two scenario kinds (load, chaos). Public barrel is scenario/recipe authoring API plus `simulationTool`; registry/lifecycle/recipe execution internals live on `@opensip-tools/simulation/internal` for tests only. | `defineLoadScenario`, `defineChaosScenario`, `defineSimulationRecipe`, `simulationTool`, `SCENARIO_KINDS`, `ASSERTIONS`, `httpTarget`, `fault` |
| `@opensip-tools/graph` | `packages/graph/engine/` | Static call-graph + dead-end analysis kernel. Seven-stage staged pipeline (discover → inventory → edges → indexes → features → rules → render). Language-agnostic — adapters live in their own publishable packages (see "Graph language adapters" below); the CLI discovers them at startup and discovers them per command through the generic capability loader (`loadCapabilityDomain`). Returns a `SignalEnvelope` (assembled in `cli/build-envelope.ts`); the shared `formatSignalSarif` formatter and all egress are owned by the composition root (ADR-0011). Depends on `@opensip-tools/contracts`, not fitness or `@opensip-tools/output` | `graphTool`, `GraphLanguageAdapter` (type), `pickAdapter`, `defineGraphRecipe`, `defineRule`, `Catalog`/`Rule` (types) |

## Layer 5 — fitness check packs and graph adapter packs

### Graph language adapters (five languages + shared scaffolding)

Distinct from the fitness language adapters above — these implement the graph engine's `GraphLanguageAdapter` contract (catalog inventory, edge extraction). Each is a publishable npm package marked with `opensipTools.kind: "graph-adapter"`; the CLI discovers them per command through the generic capability loader, which routes each `adapter` export to graph's registrar.

The four tree-sitter adapters (Python, Rust, Go, Java) are backed by **`web-tree-sitter`** (the WASM build — no native tree-sitter binding) and share `@opensip-tools/graph-adapter-common`, the tree-sitter scaffolding package (discover/parse/walk/cache-key factories). It sits downstream of the engine and upstream of the four tree-sitter adapters. The TypeScript adapter is the exception — it resolves its call graph through the TS compiler API, not tree-sitter.

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-tools/graph-adapter-common` | `packages/graph/graph-adapter-common/` | Shared tree-sitter scaffolding (discover/parse/walk/cache-key factories) for the tree-sitter graph adapters. Depends on `core`, `graph`, `web-tree-sitter`. Downstream of the engine, upstream of go/java/python/rust | discover/parse/walk/cache-key factory helpers |
| `@opensip-tools/graph-typescript` | `packages/graph/graph-typescript/` | TypeScript graph adapter — symbol-resolved call graph via TS compiler API | `typescriptGraphAdapter` |
| `@opensip-tools/graph-python` | `packages/graph/graph-python/` | Python graph adapter — `web-tree-sitter` backed | `pythonGraphAdapter` |
| `@opensip-tools/graph-rust` | `packages/graph/graph-rust/` | Rust graph adapter — `web-tree-sitter` backed | `rustGraphAdapter` |
| `@opensip-tools/graph-go` | `packages/graph/graph-go/` | Go graph adapter — `web-tree-sitter` backed | `goGraphAdapter` |
| `@opensip-tools/graph-java` | `packages/graph/graph-java/` | Java graph adapter — `web-tree-sitter` backed | `javaGraphAdapter` |

### Fitness check packs

Each pack implements the `FitPluginExports` contract: a required `checks: Check[]` (each carrying its own display) plus optional `recipes` (there is no `metadata` export — name and version come from the pack's `package.json`). Discovered via the scope-independent `opensipTools.kind: "fit-pack"` marker, or by exact package name in `plugins.checkPackages:`. See [`80-implementation/02-plugin-loader.md`](/docs/opensip-tools/80-implementation/02-plugin-loader/) for the resolution rules.

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-tools/checks-universal` | `packages/fitness/checks-universal/` | Cross-language checks (text/regex/file shape) | `checks` (each carrying display), plus per-check named exports |
| `@opensip-tools/checks-typescript` | `packages/fitness/checks-typescript/` | TypeScript/Node.js checks | `checks` (display folded on) |
| `@opensip-tools/checks-python` | `packages/fitness/checks-python/` | Python checks | `checks` (display folded on) |
| `@opensip-tools/checks-java` | `packages/fitness/checks-java/` | Java checks | `checks` (display folded on) |
| `@opensip-tools/checks-go` | `packages/fitness/checks-go/` | Go checks | `checks` (display folded on) |
| `@opensip-tools/checks-cpp` | `packages/fitness/checks-cpp/` | C/C++ checks (clang-tidy backed) | `checks` (display folded on) |
| `@opensip-tools/checks-rust` | `packages/fitness/checks-rust/` | Rust checks | `checks` (display folded on) |

## Layer 6 — composition root

Imports every layer below. The published binary.

| Package | Path | Role | Key exports |
|---|---|---|---|
| `opensip-tools` | `packages/cli/` | The `opensip-tools` command-line binary; argv parsing, Tool registration, top-level commands | `bin/opensip-tools`, `decideOpen`, `launchBrowser`, `printWelcome`, `executeUninstall`, `getErrorSuggestion` (re-export) |

> **Folder name vs. package name.** The directory is `packages/cli/`, but the
> published npm package is the **unscoped `opensip-tools`** — the single package
> end-users install with `curl -fsSL https://opensip.ai/cli/install.sh | bash`. It is the *only* unscoped
> package; every other package is `@opensip-tools/*`. It was renamed from
> `@opensip-tools/cli` to `opensip-tools` in v2.4.0 so the install command is
> just the `opensip-tools` binary; the directory deliberately kept its historical
> `cli` name to avoid churning every import path, workspace glob, and
> dependency-cruiser rule for a cosmetic rename. The old `@opensip-tools/cli`
> name is frozen at `2.3.3` and deprecated on npm with a migration message — see
> the upgrade note in [`../00-start/00-quick-start.md`](/docs/opensip-tools/00-start/00-quick-start/).

## Adding a new package

1. **Decide the layer.** Apply the rules in [`../10-concepts/03-modular-monolith.md`](/docs/opensip-tools/10-concepts/03-modular-monolith/): kernel = zero tool knowledge; contracts = used by every tool; tools = own a Tool contract; language adapters = implement `LanguageAdapter`; check packs = ship `Check[]`; cli = composition root only.
2. **Add the dep-cruiser carve-out** if needed. The default layer rules forbid most cross-layer edges; if your package needs an exception, add it to [`.config/dependency-cruiser.cjs`](https://github.com/opensip-ai/opensip-tools/blob/v3.0.0/.config/dependency-cruiser.cjs) and document it in [`../80-implementation/05-layer-policy.md`](/docs/opensip-tools/80-implementation/05-layer-policy/).
3. **Add a row** in the right table above with the canonical npm name, path, one-line role (concrete, not "fitness concerns"), and 1–3 key exports a reader would grep for.
4. **Update the layer narrative** in `10-concepts/03-modular-monolith.md` if the new package changes what the layer *means*. Pure additions to an existing pattern don't need a narrative edit — just the row here.

---

## Verification trail

Last verified at v3.0.0 against:

- `packages/` directory listing — **32 publishable packages** total (all at `3.0.0`):
  - Layer 1 (kernel): 1 — `core`
  - Layer 2 (datastore + contracts + tree-sitter + cli-ui): 4 — `datastore`, `contracts`, `tree-sitter`, `cli-ui`
  - Layer 3 (config + session-store + output + dashboard + fitness language adapters): 10 — `config`, `session-store`, `output`, `dashboard`, `lang-typescript`, `lang-rust`, `lang-python`, `lang-java`, `lang-go`, `lang-cpp`
  - Layer 4 Tools: 3 — `fitness`, `simulation`, `graph`
  - Layer 5 (check packs + graph adapter packs/scaffolding): 13 — `checks-universal`, `checks-typescript`, `checks-python`, `checks-java`, `checks-go`, `checks-cpp`, `checks-rust`, `graph-adapter-common`, `graph-typescript`, `graph-python`, `graph-rust`, `graph-go`, `graph-java`
  - Layer 6 (composition root): 1 — `cli`
- v2.0.0 promoted graph language adapters from internal subdirs to publishable npm packages (`@opensip-tools/graph-*`), added `checks-rust` to the bundled check packs, and split `dashboard` and `cli-ui` into peer-layer libraries to keep Tool engines free of UI-kit and rendering dependencies. Since then the tree-sitter graph adapters moved to the WASM `web-tree-sitter` build and grew a shared `@opensip-tools/graph-adapter-common` scaffolding package, the shared `@opensip-tools/tree-sitter` substrate (ADR-0010) was extracted as its own Layer 2 package, and `@opensip-tools/config` became the dedicated config composer/schema-registry package (ADR-0023) (→ 32 packages). The fitness language adapters (`@opensip-tools/lang-*`) and the graph language adapters (`@opensip-tools/graph-*`) are unrelated siblings implementing different contracts (`LanguageAdapter` vs. `GraphLanguageAdapter`) — see [`50-extend/05-language-adapters.md`](/docs/opensip-tools/50-extend/05-language-adapters/) for the distinction.
- Each package's `package.json` `description` and `name` field, read directly.
- The dep-cruiser config for layer rules.
