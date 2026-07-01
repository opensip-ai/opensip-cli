---
status: current
last_verified: 2026-06-27
release: v0.2.0
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

Flat, lookup-shaped reference for every workspace package, grouped by layer. For the *why* behind the layers — what "kernel" means, the import-rule arrows, the worked example threading through them — see [`../10-concepts/03-modular-monolith.md`](/docs/opensip-cli/10-concepts/03-modular-monolith/).

## How to use this page

Find the package by name, click through to its source dir, then `src/index.ts` for the full export surface. The "Key exports" column lists the one to three grep-anchors most worth knowing — not the full API.

## Layer 1 — kernel

Pure types, registries, errors, IDs, logger, paths. No tool-specific knowledge.

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-cli/core` | `packages/core/` | Kernel — language adapters, plugin loader, errors, logger, IDs, retry, project config, per-invocation execution scope | `Tool`, `ToolRegistry`, `LanguageAdapter`, `LanguageRegistry`, `RunScope`, `runWithScope`, `currentScope`, `Registry`, `Signal`, `createSignal`, `discoverPlugins`, `discoverToolPackages`, `resolveProjectPaths`, `resolveUserPaths`, `renderGateCompareLines`, `projectJsonScalarMetadata`, `logger`, `ToolError`, `ValidationError` |

## Layer 2 — datastore, contracts, authoring helpers, tree-sitter, clone-detection, cli-ui, and cli-live

`@opensip-cli/datastore` is the SQLite + Drizzle persistence kernel; it sits between `core` and the rest of this layer and depends only on `core`. Tools and `session-store` own their domain schemas (sessions in session-store; baseline/catalog in graph; baseline in fitness). Adding a new tool means adding a new schema module — datastore is paradigm-agnostic infrastructure.

`@opensip-cli/contracts` defines the contract layer between Tools and the runner — the `SignalEnvelope` output shape every tool returns, exit codes, the cross-tool `StoredSession` type, the `GraphCatalog` surface, and small tool-facing helpers such as `defineCommand`. It is not a host runtime package: no persistence, rendering, config I/O, or tool execution lives here. Imports `core` only.

`@opensip-cli/tool-test-kit` is the public author-testing package. It provides a `ToolCliContext` test double, scope helpers, and command-spec assertion helpers without importing the CLI composition root.

`@opensip-cli/tree-sitter` is the grammar-agnostic tree-sitter substrate (ADR-0010): the `web-tree-sitter` lifecycle (parser init/load) plus grammar-agnostic node accessors. Like `datastore` it imports `core` only (plus `web-tree-sitter`) and sits below the adapters that consume it — the fitness `lang-*` adapters and the four tree-sitter `graph-*` adapters (via `graph-adapter-common`) share it so the WASM lifecycle and node-walking helpers live in exactly one place. A dependency-cruiser rule (`tree-sitter-imports-core-only`) pins it to that substrate position.

`@opensip-cli/clone-detection` is the shared function-body clone-detection substrate (ADR-0064): body hashing, MinHash/LSH primitives, the tool-neutral `CloneCandidate` shape, and exact/near-duplicate curation policy. It imports no workspace package, so graph and yagni can both depend on it without a tool-to-tool edge.

`@opensip-cli/cli-ui` is the shared Ink/React presentational substrate (`Banner`, `Spinner`, `RunHeader`, `theme`). It is intentionally below tools so a tool with a live view can render with the common UI kit without depending on the CLI composition root.

`@opensip-cli/cli-live` is the shared live-run shell: the state machine, `produce()` seam, host glue, and error scrubbing that let tools render through `cli-ui` without importing the CLI dispatcher.

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-cli/datastore` | `packages/datastore/` | SQLite + Drizzle persistence kernel — `DataStore` interface, factory, in-memory + on-disk backends, workspace migration store under `migrations/`, `user_version` schema-stamp guard | `DataStore`, `DataStoreFactory`, `DataStoreOpenOptions`, `DataStoreMigrationError`, `DataStoreVersionError` |
| `@opensip-cli/contracts` | `packages/contracts/` | Shared contract facade — the `SignalEnvelope`/`CommandResult` shapes, exit codes, the cross-tool `StoredSession` type, `GraphCatalog` surface, and small tool-facing helpers | `SignalEnvelope`, `RunVerdict`, `UnitResult`, `buildSignalEnvelope`, `CommandResult`, `EXIT_CODES`, `getErrorSuggestion`, `StoredSession`, `ToolSessionRecord`, `GraphCatalog`, `defineCommand` |
| `@opensip-cli/tool-test-kit` | `packages/tool-test-kit/` | Public tool-author test helpers — in-memory `ToolCliContext` double, scope helpers, and command-spec output assertions. Depends on `core` + `contracts`, not the CLI composition root. | `createToolCliContextDouble`, `runCommandSpec`, `assertSignalEnvelope`, `assertCommandResult`, `makeTestScope` |
| `@opensip-cli/tree-sitter` | `packages/tree-sitter/` | Grammar-agnostic `web-tree-sitter` substrate (ADR-0010) — WASM parser lifecycle + node accessors, shared by the fitness `lang-*` and graph tree-sitter adapters. Depends on `web-tree-sitter` (and `core`) only | `createParser`, `parseToTree`, `walkNodes`, `findEnclosing`, `nameOf`, `childrenOf`, `namedChildrenOf`, `nodeText` |
| `@opensip-cli/clone-detection` | `packages/clone-detection/` | Shared function-body clone-detection substrate (ADR-0064) — body digest, MinHash/LSH signatures, tool-neutral clone candidate shape, exact and near-duplicate curation policy. Leaf package; no workspace imports. | `digestCanonicalBody`, `normalizeWhitespace`, `bodySignature`, `findDuplicateBodies`, `findNearDuplicates`, `isTestFilePath`, `CloneCandidate` |
| `@opensip-cli/cli-ui` | `packages/cli-ui/` | Shared Ink/React presentational primitives — Banner, Spinner, RunHeader, theme. Extracted from `cli/` so tools that ship a live view depend on the UI kit without pulling in the dispatcher. | `Banner`, `Spinner`, `RunHeader`, `theme` |
| `@opensip-cli/cli-live` | `packages/cli-live/` | Shared live-run runtime — host glue, `produce()` lifecycle, and error scrubbing over the `cli-ui` LiveRun shell. Extracted so tool packages can render live progress without depending on `opensip-cli`. | `runToolLiveView`, `HostGlue`, `LiveRunSpec`, `LiveRunOutcome` |

## Layer 3 — config, session/output/dashboard libraries, external-tool substrate, and fitness language adapters

Packages above the substrate, below tool engines. These are shared libraries consumed by the CLI and tools but not tools themselves; the external-tool substrate turns local scanner descriptors into Tool implementations, and fitness language adapters implement `LanguageAdapter`.

### Shared libraries

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-cli/config` | `packages/config/` | Project-config schema composer and document loaders — validates host-owned blocks plus tool-contributed namespaces as one strict document before dispatch | `composeConfigSchema`, `validateConfigDocument`, `resolveConfig`, `loadCliDefaults`, `cliConfigSchema`, `ToolConfigDeclaration`, `hostConfigDeclarations`, `resolveEffectiveCloudConfig` |
| `@opensip-cli/targeting` | `packages/targeting/` | Host file-targeting runtime substrate (ADR-0037) — `TargetRegistry`, uniform glob expansion with `globalExcludes`, built once per run by the CLI bootstrap and exposed as `scope.targets`. Depends on `config` + `core` only (`targeting-imports-config-core-only`) | `TargetRegistry`, `resolveTargets`, `preResolveAllTargets`, `applyGlobalExcludes` |
| `@opensip-cli/session-store` | `packages/session-store/` | Session persistence — `SessionRepo` runtime over the (package-internal) `sessions`/`session_tool_payload` schema, session-id helpers. Depends on `core`, `datastore`, `contracts` | `SessionRepo`, `SessionListOptions`, `generateSessionId`, `sanitizeForFilename` |
| `@opensip-cli/output` | `packages/output/` | Machine output layer (renamed from `@opensip-cli/reporting`, ADR-0011): pure `format/` formatters + effectful `sink/` delivery. Depends on `core`, `contracts` | `formatSignalJson`, `formatSignalSarif`, `buildOpenSipSarif`, `formatSignalTableRows`, `formatSignalTableSummary`, `Formatter`, `postChunked`, `createCloudSignalSink`, `resolveSignalSink`, `resolveRepoIdentity`, `checkEntitlement` |
| `@opensip-cli/dashboard` | `packages/dashboard/` | Self-contained HTML report generator — renders fit/sim/graph/yagni sessions plus tool catalog data. Consumed by the CLI-owned `report` command and each tool's auto-open hook. | `generateDashboardHtml` |
| `@opensip-cli/external-tool-adapter` | `packages/external-tool-adapter/` | External scanner substrate — wraps a user-installed CLI scanner as an OpenSIP Tool: binary resolution, run loop, SARIF/JSON ingest, severity mapping, doctor/version commands, provenance, and artifact handling. | `defineExternalToolAdapter`, `ingestSarif`, `resolveBinary`, `runAcceptanceCase` |

### Language adapters (fitness — six languages)

Implement `LanguageAdapter`. Used by fitness checks and any future tool that needs per-language strip/parse routines.

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-cli/lang-typescript` | `packages/languages/lang-typescript/` | TypeScript/JavaScript adapter — TS compiler API + query layer | `typescriptAdapter`, `filterContent`, `clearFilterCache` |
| `@opensip-cli/lang-rust` | `packages/languages/lang-rust/` | Rust adapter — strip routines + line-offset metadata | `rustAdapter` |
| `@opensip-cli/lang-python` | `packages/languages/lang-python/` | Python adapter — strip routines | `pythonAdapter` |
| `@opensip-cli/lang-java` | `packages/languages/lang-java/` | Java adapter — strip routines | `javaAdapter` |
| `@opensip-cli/lang-go` | `packages/languages/lang-go/` | Go adapter — strip routines | `goAdapter` |
| `@opensip-cli/lang-cpp` | `packages/languages/lang-cpp/` | C/C++ adapter — strip routines | `cppAdapter` |

## Layer 4 — tools and tool adapters

Tool engines and opt-in tool adapters implement the `Tool` contract. They are peer domains: none imports another tool or the CLI.

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-cli/fitness` | `packages/fitness/engine/` | Fitness check engine, `defineCheck`, `defineRecipe`, gate. Returns a `SignalEnvelope`; SARIF/cloud egress is owned by the composition root (ADR-0011). The engine, recipe service, registries, gate/baseline primitives, and CLI handlers are package-internal (curated barrel, ADR-0013) — locked by `public-api.test.ts` | `defineCheck`, `defineRecipe`, `getCheckConfig`, `fitnessTool` (+ the AST/text authoring helpers: `isTestFile`, `stripStringsAndComments`, `extractSnippet`, …) |
| `@opensip-cli/simulation` | `packages/simulation/engine/` | Simulation engine, two scenario kinds (load, chaos). Public barrel is scenario/recipe authoring API plus `simulationTool`; registry/lifecycle/recipe execution internals live on `@opensip-cli/simulation/internal` for tests only. | `defineLoadScenario`, `defineChaosScenario`, `defineSimulationRecipe`, `simulationTool`, `SCENARIO_KINDS`, `ASSERTIONS`, `httpTarget`, `fault` |
| `@opensip-cli/graph` | `packages/graph/engine/` | Static call-graph + dead-end analysis kernel. Seven-stage staged pipeline (discover → inventory → edges → indexes → features → rules → render). Language-agnostic — adapters live in their own publishable packages (see "Graph language adapters" below); the CLI discovers them at startup and discovers them per command through the generic capability loader (`loadCapabilityDomain`). Returns a `SignalEnvelope` (assembled in `cli/build-envelope.ts`); the shared `formatSignalSarif` formatter and all egress are owned by the composition root (ADR-0011). Depends on `@opensip-cli/contracts`, not fitness or `@opensip-cli/output` | `graphTool`, `GraphLanguageAdapter` (type), `pickAdapter`, `defineGraphRecipe`, `defineRule`, `Catalog`/`Rule` (types) |
| `@opensip-cli/yagni` | `packages/yagni/engine/` | Advisory YAGNI reduction audit. Detector framework over TypeScript sources: config-surface reduction plus exact duplicate-body candidates. Duplicate detection builds yagni's own TypeScript inventory and consumes `@opensip-cli/clone-detection` (ADR-0064); no runtime `@opensip-cli/graph` dependency. Returns a `SignalEnvelope` with `metadata.yagni` on each finding. Advisory defaults (`failOnErrors: 0`). | `yagniTool`, `YAGNI_STABLE_ID`, `YAGNI_CONTRACT_VERSION` |
| `@opensip-cli/mcp` | `packages/mcp/` | MCP stdio tool — exposes the OpenSIP graph catalog and stored session results to coding agents over Model Context Protocol. Loaded by the host like any other bundled Tool package. | `mcpTool`, `tool`, `MCP_IDENTITY`, `MCP_STABLE_ID` |
| `@opensip-cli/tool-gitleaks` | `packages/tool-gitleaks/` | Opt-in external scanner adapter for Gitleaks — committed-secret scanning via a user-installed `gitleaks` binary, normalized into OpenSIP `Signal`s with doctor/version commands. | `tool`, `parseGitleaksJson`, `GITLEAKS_IDENTITY`, `GITLEAKS_STABLE_ID` |
| `@opensip-cli/tool-osv-scanner` | `packages/tool-osv-scanner/` | Opt-in external scanner adapter for OSV-Scanner — dependency vulnerability scanning via a user-installed `osv-scanner` binary, normalized into OpenSIP `Signal`s with doctor/version commands. | `tool`, `parseOsvJson`, `OSV_SCANNER_IDENTITY`, `OSV_SCANNER_STABLE_ID` |
| `@opensip-cli/tool-trivy` | `packages/tool-trivy/` | Opt-in external scanner adapter for Trivy — filesystem vulnerability and misconfiguration scanning via a user-installed `trivy` binary, normalized through the shared SARIF ingest path. | `tool`, `TRIVY_IDENTITY`, `TRIVY_STABLE_ID` |

## Layer 5 — fitness check packs and graph adapter packs

### Graph language adapters (five languages + shared scaffolding)

Distinct from the fitness language adapters above — these implement the graph engine's `GraphLanguageAdapter` contract (catalog inventory, edge extraction). Each is a publishable npm package marked with `opensipTools.kind: "graph-adapter"` plus the graph-adapter target-domain epoch; the CLI discovers them per command through the generic capability loader, which routes each `adapter` export to graph's registrar.

The four tree-sitter adapters (Python, Rust, Go, Java) are backed by **`web-tree-sitter`** (the WASM build — no native tree-sitter binding) and share `@opensip-cli/graph-adapter-common`, the tree-sitter scaffolding package (discover/parse/walk/cache-key factories). It sits downstream of the engine and upstream of the four tree-sitter adapters. The TypeScript adapter is the exception — it resolves its call graph through the TS compiler API, not tree-sitter.

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-cli/graph-adapter-common` | `packages/graph/graph-adapter-common/` | Shared tree-sitter scaffolding (discover/parse/walk/cache-key factories) for the tree-sitter graph adapters. Depends on `core`, `graph`, `web-tree-sitter`. Downstream of the engine, upstream of go/java/python/rust | discover/parse/walk/cache-key factory helpers |
| `@opensip-cli/graph-typescript` | `packages/graph/graph-typescript/` | TypeScript graph adapter — symbol-resolved call graph via TS compiler API | `typescriptGraphAdapter` |
| `@opensip-cli/graph-python` | `packages/graph/graph-python/` | Python graph adapter — `web-tree-sitter` backed | `pythonGraphAdapter` |
| `@opensip-cli/graph-rust` | `packages/graph/graph-rust/` | Rust graph adapter — `web-tree-sitter` backed | `rustGraphAdapter` |
| `@opensip-cli/graph-go` | `packages/graph/graph-go/` | Go graph adapter — `web-tree-sitter` backed | `goGraphAdapter` |
| `@opensip-cli/graph-java` | `packages/graph/graph-java/` | Java graph adapter — `web-tree-sitter` backed | `javaGraphAdapter` |

### Fitness check packs

Each pack implements the `FitPluginExports` contract: a required `checks: Check[]` (each carrying its own display) plus optional `recipes` (there is no `metadata` export — name and version come from the pack's `package.json`). Discovered via the scope-independent `opensipTools.kind: "fit-pack"` marker with `targetDomain: "fit-pack"` / `targetDomainApiVersion`, or by exact package name in `plugins.checkPackages:`. See [`80-implementation/02-plugin-loader.md`](/docs/opensip-cli/80-implementation/02-plugin-loader/) for the resolution rules.

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-cli/checks-universal` | `packages/fitness/checks-universal/` | Cross-language checks (text/regex/file shape) | `checks` (each carrying display) |
| `@opensip-cli/checks-typescript` | `packages/fitness/checks-typescript/` | TypeScript/Node.js checks | `checks` (display folded on) |
| `@opensip-cli/checks-python` | `packages/fitness/checks-python/` | Python checks | `checks` (display folded on) |
| `@opensip-cli/checks-java` | `packages/fitness/checks-java/` | Java checks | `checks` (display folded on) |
| `@opensip-cli/checks-go` | `packages/fitness/checks-go/` | Go checks | `checks` (display folded on) |
| `@opensip-cli/checks-cpp` | `packages/fitness/checks-cpp/` | C/C++ checks (clang-tidy backed) | `checks` (display folded on) |
| `@opensip-cli/checks-rust` | `packages/fitness/checks-rust/` | Rust checks | `checks` (display folded on) |

## Layer 6 — composition root

Imports every layer below. The published binary.

| Package | Path | Role | Key exports |
|---|---|---|---|
| `opensip-cli` | `packages/cli/` | The `opensip` command-line binary; argv parsing, Tool registration, top-level commands | `bin/opensip`, `decideReportOpen`, `launchReport`, `printWelcome`, `executeUninstall`, `getErrorSuggestion` (re-export) |

> **Folder name vs. package name.** The directory is `packages/cli/`, but the
> published npm package is the **unscoped `opensip-cli`** — the single package
> end-users install with `curl -fsSL https://opensip.ai/cli/install.sh | bash`.
> It is the only unscoped package; every other package is `@opensip-cli/*`.
> The package installs the `opensip` binary.

## Workspace-private (never published)

| Package | Path | Role | Key exports |
|---|---|---|---|
| `@opensip-cli/test-support` | `packages/test-support/` | Cross-package TEST scaffolding (ADR-0040): `RunScope` test sugar + the per-check fixture-coverage harness consumed by each check pack's `fixture-coverage.test.ts`. `private: true` — excluded from the release order; production source may not import it (`no-prod-import-of-test-support` depcruise rule) | `makeTestScope`, `withScope`, `withScopeSync`, `runCheckOnFixture`, `planCoverageCases`, `buildFixtureManifest` |

## Adding a new package

1. **Decide the layer.** Apply the rules in [`../10-concepts/03-modular-monolith.md`](/docs/opensip-cli/10-concepts/03-modular-monolith/): kernel = zero tool knowledge; contracts = used by every tool; tools = own a Tool contract; language adapters = implement `LanguageAdapter`; check packs = ship `Check[]`; cli = composition root only.
2. **Add the dep-cruiser carve-out** if needed. The default layer rules forbid most cross-layer edges; if your package needs an exception, add it to [`.config/dependency-cruiser.cjs`](https://github.com/opensip-ai/opensip-cli/blob/v0.2.0/.config/dependency-cruiser.cjs) and document it in [`../80-implementation/05-layer-policy.md`](/docs/opensip-cli/80-implementation/05-layer-policy/).
3. **Add a row** in the right table above with the canonical npm name, path, one-line role (concrete, not "fitness concerns"), and 1–3 key exports a reader would grep for.
4. **Update the layer narrative** in `10-concepts/03-modular-monolith.md` if the new package changes what the layer *means*. Pure additions to an existing pattern don't need a narrative edit — just the row here.

---

## Verification trail

Last verified at v0.2.0 against `scripts/release-package-order.mjs` (the publishable
package source of truth) and the layer tables above:

- **42 publishable packages** total (all at `0.2.0`), plus one workspace-private
  `@opensip-cli/test-support` package and the private root `@opensip-cli/root`:
  - Layer 1 (kernel): 1 — `core`
  - Layer 2 (datastore + contracts + authoring helpers + tree-sitter + clone-detection + cli-ui + cli-live): 7 —
    `datastore`, `contracts`, `tool-test-kit`, `tree-sitter`, `clone-detection`, `cli-ui`, `cli-live`
  - Layer 3 (config + targeting + session-store + output + dashboard + external-tool substrate + fitness language adapters): 12 —
    `config`, `targeting`, `session-store`, `output`, `dashboard`, `lang-typescript`,
    `lang-rust`, `lang-python`, `lang-java`, `lang-go`, `lang-cpp`, `external-tool-adapter`
  - Layer 4 Tools/tool adapters: 8 — `fitness`, `simulation`, `graph`, `yagni`,
    `mcp`, `tool-gitleaks`, `tool-osv-scanner`, `tool-trivy`
  - Layer 5 (check packs + graph adapter packs/scaffolding): 13 —
    `checks-universal`, `checks-typescript`, `checks-python`,
    `checks-java`, `checks-go`, `checks-cpp`, `checks-rust`, `graph-adapter-common`,
    `graph-typescript`, `graph-python`, `graph-rust`, `graph-go`, `graph-java`
  - Layer 6 (composition root): 1 — `cli`
- The graph language adapters are publishable `@opensip-cli/graph-*` packages,
  backed by the shared `@opensip-cli/graph-adapter-common` scaffolding package
  and the `@opensip-cli/tree-sitter` substrate. The config composer
  (`@opensip-cli/config`) and host file-targeting runtime
  (`@opensip-cli/targeting`) are separate packages so tool engines stay focused
  on their own domains. The fitness language adapters (`@opensip-cli/lang-*`)
  and the graph language adapters (`@opensip-cli/graph-*`) are unrelated
  siblings implementing different contracts (`LanguageAdapter` vs.
  `GraphLanguageAdapter`) — see
  [`50-extend/05-language-adapters.md`](/docs/opensip-cli/50-extend/05-language-adapters/)
  for the distinction.
- Each package's `package.json` `description` and `name` field, read directly.
- The dep-cruiser config for layer rules.
