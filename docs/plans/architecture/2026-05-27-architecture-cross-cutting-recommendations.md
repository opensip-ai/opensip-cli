# Architecture audit — cross-cutting recommendations

**Date:** 2026-05-27
**Inputs:** 10 per-package reports in `docs/plans/architecture/2026-05-27-architecture-*.md`
**Auditor:** Claude

## Summary

The single highest-leverage theme across the codebase is **process-wide
mutable singletons**: at least seven distinct module-scope mutables
(`logger`, `activeCache`, `defaultLanguageRegistry`, `defaultToolRegistry`,
`fileCache`, `scenarioRegistry`, lang-typescript's `filterCache`, plus the
CLI's `currentProjectContext` / `datastoreCache`) implement the same
shape — "constructor at module load, free-function setters mutate it,
tests need a manual reset" — and they collectively block the stated
SaaS-mode invariant. Right behind it sits **registry fragmentation**:
no fewer than ten registry classes across `core`, `fitness`,
`simulation`, `graph`, and `dashboard`, each independently re-deciding
its duplicate policy (silent skip, warn-first-wins, throw, overwrite,
or `protected`-field bypass for built-ins). The third is **typed
boundaries that erase to `unknown`** — `ToolCliContext.datastore`,
`ToolCliContext.program`, `LiveViewRenderer(args)`, and
`CallSiteRecord.nodeRef`/`sourceFileRef` — that push runtime casts
into every consumer. Together those three account for ~half the
per-package findings. The remaining cross-cutting themes are smaller
but consistent: documented "side-effect imports" / "load-bearing
concatenation order" prose contracts as a substitute for the type
system; tool-shaped code leaking up into layers that advertise
tool-agnosticism (dashboard, contracts, core); and Strategy/Template
opportunities that are flagged in five different places under five
different names.

The biggest leverage move is consolidating registries and lifecycle
state behind one set of primitives in `core` — that single PR
collapses 5–6 of the themes below.

## Cross-cutting themes

### T1 — Process-wide mutable singletons replace explicit lifecycle

- **Reports flagging this:** core (F3, F7), fitness (F2, F5, F11), simulation (F1, F3, F11), languages (F5), cli (F2, F11), dashboard (F3 indirectly via side-effect imports)
- **Pattern shape:** Service Locator / Singleton anti-pattern; missing Context Object
- **What's actually in the code (verified):**
  - `packages/core/src/lib/logger.ts:231` — `export const logger: Logger = _logger;` mutated by free `setLogLevel`, etc.
  - `packages/core/src/languages/parse-cache.ts:108` — `let activeCache: LanguageParseCache | null = null;` plus free `initParseCache()` / `clearParseCache()`.
  - `packages/core/src/languages/registry.ts` — `defaultLanguageRegistry` module-scope const; `packages/core/src/tools/registry.ts:78` — `defaultToolRegistry` same.
  - `packages/fitness/engine/src/framework/file-cache.ts:210` — `export const fileCache = new FileCache()` with a 10-minute `setTimeout` auto-clear (the timer itself is evidence of a fragile lifecycle).
  - `packages/fitness/engine/src/recipes/check-config.ts:47` — `const GLOBAL_KEY = Symbol.for('@opensip-tools/fitness/currentRecipeCheckConfig')`, stored on `globalThis`. `service.ts:122`/`:175` set and clear it in a `try/finally`.
  - `packages/simulation/engine/src/framework/registry.ts:15` — `export const scenarioRegistry = new IdNameTagRegistry<RunnableScenario>(...)`. `kinds/load/define.ts:174`, `chaos/define.ts:162`, `invariant/define.ts:113`, `fix-evaluation/define.ts:266` all `scenarioRegistry.register(scenario)` as the *side effect* of `defineX(...)`. The plugin loader uses snapshot-delta accounting (`plugins/loader.ts:108-133`) precisely to observe this side effect.
  - `packages/cli/src/cli-context.ts:49-50` — `let currentProjectContext: ProjectContext | undefined; let datastoreCache: DataStore | undefined;` and `setProjectContextForRun` mutates both.
  - `packages/languages/lang-typescript/src/filter.ts:145` — separate module-level `filterCache` Map with its own 10-minute timer, distinct from `LanguageParseCache`. Cleared independently.
- **Why it matters across packages:** Every singleton individually documents the same failure mode in a comment — "if an in-process harness ever runs concurrently…", "called once before the first ensureScenariosLoaded()", "two copies of fitness can be loaded". The user-global instruction "all features must work in both embedded and SaaS modes" is structurally blocked by this pattern, not by any one site. The blast radius is large: tests across `core`, `fitness`, `simulation`, and `lang-typescript` all carry reset/clear plumbing that exists only to undo singleton state, and that plumbing is asymmetric across packages (simulation has `clearScenarioRegistry()` *and* `...WithoutRegistration` twins; lang-typescript needs both `clearParseCache()` *and* `clearFilterCache()`; fitness has `reset()` on `FitnessRecipeRegistry`; tests for the CLI live with leakage).
- **Recommended treatment:** Introduce a single `RunScope` / `ToolHost` abstraction owned by `core` and constructed once per CLI invocation (or per host in SaaS mode). It carries: `logger`, `parseCache`, `fileCache`, `recipeCheckConfig`, `projectContext`, `datastore` thunk. Three sequential moves:
  1. In `core`, give every singleton a constructor seam: `new LanguageParseCache()` already exists; do the same for `FileCache`, then expose `getParseTree(cache?, ...)` / `fileCache.get(cache?, ...)` overloads that accept the cache explicitly and fall back to the default for back-compat.
  2. Build a `RunScope` in `cli-context.ts` constructed in the preAction hook and threaded down through `ToolCliContext`. The two module-level holders go away.
  3. Replace `getCheckConfig()` / `scenarioRegistry`'s side-effect `defineX` with explicit registration: `defineX` returns a `RunnableScenario`, `host.registerScenarios(...)` / context-injected `recipeCheckConfig` are the registration boundary. The `...WithoutRegistration` twins disappear; the simulation plugin loader's snapshot-delta math (~25 lines) collapses to one call to core's `loadAllPlugins`.
- **Priority:** High
- **Effort:** L

### T2 — Registry fragmentation: ten registries, five duplicate policies, no shared base

- **Reports flagging this:** core (F1, F5, F6), fitness (F8, F11), simulation (F2), dashboard (F3, F9), graph (F5 partial)
- **Pattern shape:** Missing common abstraction (Registry + DuplicatePolicy Strategy); copy-paste generalisation
- **What's actually in the code (verified):** Ten registry classes across the workspace:
  - `packages/core/src/tools/registry.ts` — `ToolRegistry`: first-writer-wins, warn.
  - `packages/core/src/languages/registry.ts` — `LanguageRegistry`: first-writer-wins, warn + alias/extension indices.
  - `packages/core/src/recipes/registry.ts` — `RecipeRegistry`: 3-mode (`allowOverwrite` + `throwOnDuplicate` flags).
  - `packages/core/src/lib/id-name-tag-registry.ts` — silent skip on id-dup, **throws** ValidationError on name-collision.
  - `packages/fitness/engine/src/framework/registry.ts:25-28` — `CheckRegistry`: silent skip duplicate (verified: comment says "Silently skip duplicate — same check imported multiple times").
  - `packages/fitness/engine/src/recipes/registry.ts` — `FitnessRecipeRegistry`: throw on duplicate by default; constructor does I/O (loads built-ins).
  - `packages/fitness/engine/src/targets/target-registry.ts` — separate again.
  - `packages/simulation/engine/src/framework/registry.ts` — wraps `IdNameTagRegistry`.
  - `packages/simulation/engine/src/recipes/registry.ts:32-39` — `SimulationRecipeRegistry` subclasses core's `RecipeRegistry` and writes directly to `protected` `byId`/`byName` Maps to bypass the parent's duplicate guard.
  - `packages/graph/engine/src/lang-adapter/registry.ts` and `packages/graph/engine/src/rules/registry.ts` — graph adapter / rule arrays.
  - Plus `packages/dashboard/src/tool-tab-registry.ts` and the runtime `views = []` array in `code-paths/views-registry.ts`.
  The `id-name-tag-registry.ts:5-12` header explicitly describes itself as the "smaller common ancestor" of several of these, but `recipes/registry.ts:6-26` describes itself as the **other** common ancestor — both attempted generalisations exist side-by-side. Five different duplicate policies are in production simultaneously.
- **Why it matters across packages:** Adding a new registry-like consumer (the upcoming `audit`, `lint`, `bench` tools, or a graph rule-pack registry) forces another copy of the same 30-line Map+warn+index template, with the new author deciding which of the five duplicate policies to copy. The `SimulationRecipeRegistry` bypassing its parent's `protected` invariants (verified at lines 32-39) is an LSP violation that exists *because* the base class's three-mode duplicate policy doesn't have a clean "register built-ins without the duplicate guard" mode. The dashboard's runtime `views = []` is the same shape with no type at all.
- **Recommended treatment:** Promote a single `Registry<T extends { id; name; tags? }>` in `core/src/lib/registry.ts` with a closed `DuplicatePolicy = 'warn-first-wins' | 'throw' | 'overwrite' | 'silent-skip' | 'allow-internal'` discriminated union. The base owns the Map, the byId/byName indices, the policy branch, and structured-event emission. Specialised registries (`LanguageRegistry`, fitness's `CheckRegistry`, etc.) extend it and add only domain-specific indices (extension, alias, tag, scope). Delete `IdNameTagRegistry`; delete the `allowOverwrite` + `throwOnDuplicate` boolean pair in favour of the closed union; expose a `protected registerInternal()` that built-in loaders can call to skip the duplicate guard cleanly (so `SimulationRecipeRegistry` stops touching `byId` directly). Built-ins move into a factory (`createDefaultRecipeRegistry()`) instead of running in the constructor.
- **Priority:** High
- **Effort:** M

### T3 — Typed boundaries erased to `unknown`, then re-cast at every consumer

- **Reports flagging this:** core (F2), graph (F4, F7), fitness (implicit — every datastore use), simulation (every datastore use), cli (implicit — `ToolCliContext` design)
- **Pattern shape:** Leaky abstraction; missing generics; "trust me" casts
- **What's actually in the code (verified):**
  - `packages/core/src/tools/types.ts:104, 122, 146, 171, 182` — `program: unknown`, `render: (result: unknown)`, `renderLive: (key, args: unknown)`, `emitJson: (value: unknown)`, `datastore: unknown`. The JSDoc instructs every tool to runtime-cast.
  - `packages/graph/engine/src/cli/graph.ts:132, 159, 534` — `cli.datastore as DataStore | undefined` three times.
  - `packages/graph/engine/src/tool.ts:90, 207` — same.
  - `packages/fitness/engine/src/tool.ts:156, 227, 274, 325, 373` — `cli.datastore as DataStore` five times.
  - `packages/graph/engine/src/lang-adapter/types.ts:91-103` — `CallSiteRecord.nodeRef: unknown; sourceFileRef: unknown;`. Every tree-sitter adapter casts at the top of `resolveCallSites` (verified at `graph-python/src/resolve.ts:71-72`, `graph-rust/src/resolve.ts:88-89`, `graph-go/src/resolve.ts:68-69`, `graph-java/src/resolve.ts:68-69`).
  - The TS adapter (`graph-typescript/src/index.ts:107-134`) builds an internal record `{ node, sourceFile, ... }`, re-shapes to `{ nodeRef, sourceFileRef, ... }`, then `resolveCallSitesAdapter` casts back — pure boilerplate.
- **Why it matters across packages:** The `unknown` typing achieves layering decoupling but pushes the safety cost into every tool implementation. A Commander, DataStore, or tree-sitter node-shape change won't surface at the contract; it surfaces at every cast site simultaneously. Each tool re-asserts the cast 3-5 times; the audit prompt asks "are dependencies hidden in casts?" and the answer is yes, in 13+ sites across three packages.
- **Recommended treatment:** Make `ToolCliContext` and `CallSiteRecord` generic with sensible `unknown` defaults so opt-in safety is one type parameter away:
  - `interface ToolCliContext<TProgram = unknown, TDataStore = unknown>` in core. Tools declare `Tool<Command, DataStore>` and get typed access; the contract surface is unchanged for tools that don't opt in.
  - `CallSiteRecord<N = unknown, F = unknown>` in graph, exposed on the adapter as `GraphLanguageAdapter<P, N = unknown, F = unknown>`. Each adapter declares its concrete tree-sitter types; the engine still consumes `CallSiteRecord<unknown, unknown>` at the polymorphic boundary. Verified mechanical: every adapter has a single resolve-site cast that becomes an inferred narrow.
  - As a fallback, single helper functions (`requireDataStore(cli): DataStore` in each tool) at least centralise the runtime invariant validation that the casts currently elide.
- **Priority:** High
- **Effort:** S (generics) / M (full migration)

### T4 — Tool-shaped code in packages that advertise tool-agnosticism

- **Reports flagging this:** core (F4 — `Signal`), contracts (F1, F2, F3, F4, F5), dashboard (F6, F7), cli (F1 — dashboard auto-open)
- **Pattern shape:** Boundary erosion; "kitchen-sink" packages accreting tool-specific code
- **What's actually in the code (verified):**
  - `packages/core/src/types/signal.ts:9` — `Signal` carries `severity`, `category: 'security' | 'quality' | ...`, `ruleId`, `fingerprint` — the canonical fitness/graph **finding** shape. The file header even says "compatible with OpenSIP's signal format. Used by the check framework internally." Consumed by `graph/engine/src/gate.ts:14`, `graph/engine/src/types.ts:2`, etc. — never by anything kernel-shaped.
  - `packages/contracts/src/persistence/session-repo.ts:42-261` — a full Repository class with `drizzle-orm` and `@opensip-tools/datastore` runtime imports lives in a package whose `package.json` description says "Shared contract types for OpenSIP Tools."
  - `packages/contracts/src/persistence/schema/sessions.ts` — runtime `sqliteTable(...)` values exported from the contracts barrel (`index.ts:80`).
  - `packages/contracts/src/persistence/store.ts:70-77` — header claims "type-only facade" but exports `generateSessionId` (calls `randomUUID`) and `sanitizeForFilename`.
  - `packages/cli/src/bootstrap/dashboard.ts:43` — `const { openDashboard } = await import('@opensip-tools/fitness');` exposed via `ctx.maybeOpenDashboard` on the generic `ToolCliContext` — every tool can call it, but only fitness's dashboard ever opens.
  - `packages/dashboard/src/overview.ts:35-78` — hard-codes the columns `['Timestamp','Tool','Recipe','Pass Rate','Status','Checks','Findings','Duration']` and reads `s.summary.passed/failed/errors/warnings`. The package claims tool-agnosticism via `ToolTabDescriptor` but Recent Activity is fit/sim-shaped.
  - `packages/dashboard/src/tool-tabs.ts:66-76` — Simulation tab passes `[]` and `function(container, data) {}` because the shape it inherits is "fit minus catalog."
- **Why it matters across packages:** CLAUDE.md explicitly says "Nothing fitness-shaped, graph-shaped, or CLI-shaped belongs in core" and frames contracts as the typed seam. Both invariants are violated, and the violations are not surface-deep: `Signal` is in core because every tool happens to emit findings; `SessionRepo` is in contracts because no single tool owns sessions; `openDashboard` is in cli because the CLI wants a `--open` flag and only fitness can serve it. The pattern is "no obvious owner → drop it in the lowest layer that doesn't reject it" — and `core` / `contracts` don't reject anything.
- **Recommended treatment:** Move shapes to the right layer; introduce explicit hooks where one is genuinely needed:
  1. `Signal` / `createSignal` → `@opensip-tools/contracts`. The layer rule (`core ← contracts ← tools`) supports this trivially; consumers re-import.
  2. `SessionRepo`, `sessions/sessionChecks/sessionFindings` Drizzle tables, `generateSessionId`, `sanitizeForFilename` → either a new `@opensip-tools/session-repo` package or fold into `@opensip-tools/datastore`. Keep only the `StoredSession` *type* in contracts. Contracts can then drop its `drizzle-orm` and `@opensip-tools/datastore` runtime deps and become genuinely type-only.
  3. `maybeOpenDashboard` → off `ToolCliContext`; add a `PostRunHookRegistry` mirroring `LiveViewRegistry` so fitness (or any future tool) registers its post-run artifact opener by tool-id. The dynamic `import('@opensip-tools/fitness')` in `bootstrap/dashboard.ts` disappears.
  4. Dashboard Overview/per-tool tables — extend `ToolTabDescriptor` with `renderOverviewRow(session)` and `subtabs: SubtabDescriptor[]`, so each tool's session shape stays the tool's concern. The Simulation `[]` + no-op pair (verified at `tool-tabs.ts:66-76`) becomes a single-subtab registration.
  5. Update CLAUDE.md to match: contracts is "CLI surface contracts" (exit codes, result shapes, catalog types), not "the Tool↔runner contract." The Tool interface lives in core (verified at `core/src/tools/types.ts:185`).
- **Priority:** High
- **Effort:** M

### T5 — "Documented prose contracts" substituting for the type system

- **Reports flagging this:** dashboard (F1, F2, F12 — load-bearing concat order; `view-template.ts` raw-JS strings), cli (F14 — completion subcommands), datastore (F7 — drizzle.config.ts schema list), graph (F1 — `RuleHints` threading), fitness (F7 — globalExcludes double-application), cli (multiple side-effect comments)
- **Pattern shape:** Untyped contract enforced by comment + (sometimes) a drift test
- **What's actually in the code (verified):**
  - `packages/dashboard/src/code-paths.ts:43-77` and `shared.ts:18-23` — both explicitly say "Concatenation order is load-bearing — each emitter declares top-level names that later emitters reference. Reordering will silently break the page with `<name> is not defined`."
  - `packages/dashboard/src/code-paths/view-template.ts:51` — "JS source for the cell value, spliced VERBATIM into the emitted view body — there is no TS type-checking on this expression."
  - `packages/dashboard/src/generator.ts:18` and `overview.ts:13` — both do `import './tool-tabs-registrations.js' // side-effect: registers fit/sim/graph` (verified identical comment in both files).
  - `packages/cli/src/commands/completion.ts:29-47` — hardcoded `SUBCOMMANDS` list with a header comment "Kept in sync with the live Commander program at test time — see `__tests__/completion-subcommands.test.ts` (drift catch)." Third-party tool subcommands cannot be in the list by construction.
  - `packages/datastore/drizzle.config.ts:5-9` — verified: hand-curated list of `['../contracts/src/persistence/schema/sessions.ts', '../graph/engine/src/persistence/schema.ts', '../fitness/engine/src/persistence/schema.ts']`. Adding a new tool with persistence means editing datastore.
  - `packages/graph/engine/src/cli/orchestrate.ts:189-201` — `rule.evaluate(catalog, indexes, config)` with no `hints` arg, even though every adapter populates `ruleHints` and the rule signature is `evaluate(catalog, indexes, config, hints?)`. The fallback comments explicitly say "the rule keeps firing on the language it was originally authored for." This is a *correctness bug* born of the implicit contract.
  - `packages/fitness/engine/src/framework/execution-context.ts:131-184` and `scope-resolver.ts:152-227` — both have ~10-line comments explaining where `globalExcludes` are applied and why.
- **Why it matters across packages:** When a package's correctness depends on a comment, refactors are gated on humans noticing the comment. The graph F1 finding is the proof: every adapter carefully populates `ruleHints`; the orchestrator forgets to pass them; in production every Python project gets TypeScript regex heuristics for "is this a side-effecting call" — and the bug is invisible to tests because the rule still fires *something*. The dashboard's "load-bearing concatenation order" is the same shape but hasn't yet bit. The completion drift problem is the same shape and provably cannot be fixed for third-party tools without an architecture change.
- **Recommended treatment:** Replace prose contracts with code that can fail to compile:
  - **Dashboard runtime**: author emitters as real ESM modules under `src/runtime/`, bundle once at package build time with esbuild/rollup into one IIFE string. The topo order disappears; `el`/`passesFilter`/`graphCatalog` become real imports. The `defineRankedView` raw-JS strings become real function literals.
  - **Side-effect imports**: replace with explicit `getDefaultToolTabs()` returning the array, or `registerDefaultToolTabs()` called once at the top of `generateDashboardHtml`. Both consumers call the same function; missing registration is a missing call, not a silent empty registry.
  - **Completion**: generate from the live Commander program after `mountAllToolCommands` runs. Third-party tools get completion for free; drift is impossible by construction.
  - **drizzle.config.ts**: each persistence-owning package ships its own migrations; `@opensip-tools/datastore` exposes `runMigrations(folder)` as a primitive. Datastore stops enumerating its consumers.
  - **Graph orchestrator**: pass `adapter.ruleHints` down through `runGraph` (verified one-line fix at `orchestrate.ts:189-201`). Add an invariant test in `graph-catalog-drift.test.ts` asserting every hint-capable rule receives them in the orchestrator path.
  - **globalExcludes**: bake into `buildScopeBasedFileMap`'s output so the fileCache fallback path consults the same `Map<slug, files>`. Applied once, at one site.
- **Priority:** High (graph F1 is a real bug; others are latent)
- **Effort:** M overall; graph fix is S, dashboard runtime bundle is M-L

### T6 — Repeated extraction-candidate utilities across packages

- **Reports flagging this:** fitness (F3 — five regex-list reimplementations), graph (F2, F3, F8, F9 — four parse/resolve/discard/cache-key duplications), languages (F9, F11 — Python and Rust scanner divergence), cli (F5 — `formatBytes` mirrored in App.tsx and uninstall.ts; F10 — `discoverAndRegister*` duplicate)
- **Pattern shape:** Missing Template Method / shared helper (DRY)
- **What's actually in the code (verified):**
  - Fitness language packs use `defineCheck` plus a hand-rolled regex loop, even though the engine ships `defineRegexListCheck`. Verified at `packages/fitness/checks-python/src/checks/no-bare-except.ts:16,43`, `checks-go/src/checks/no-fmt-print.ts:13,43`, `checks-rust/src/checks/no-dbg-macro.ts:13,44`. The `checks-universal` pack does use `defineRegexListCheck` (verified in `no-console-log.ts`, `no-window-alert.ts`, `no-process-artifacts.ts`). So the helper exists, the universal pack uses it, the four language packs don't.
  - Graph adapters: four tree-sitter `parseProject` files (`graph-python/src/parse.ts`, `graph-rust/src/parse.ts`, `graph-go/src/parse.ts`, `graph-java/src/parse.ts`) are each ~88 lines and structurally identical (parse loop, `hasError` ParseError emission, `as unknown as Parser.Language` cast, same log event shape). Same shape for `resolveCallSites`, `isReturnValueDiscarded`, and `cacheKey` — duplicated 3-4 times each.
  - `packages/languages/lang-rust/src/strip.ts:125-167` — 40-line inline char-literal scanner that the source comment admits "Core's `scanCharLiteral` helper *does* distinguish overflow from success, so a migration to that helper with a `result.end === i + 1` lifetime branch is feasible." Then doesn't migrate. Result: lang-rust's char cap is 8 but lang-cpp uses 12 for unicode escapes, and Rust's `'\u{1F600}'` needs ≥10 — a real correctness gap.
  - `packages/cli/src/ui/App.tsx:296-301` and `packages/cli/src/commands/uninstall.ts:150-155` — same `formatBytes` / `formatSize` body, with a comment "Mirror of `formatUninstallSize` so the renderer doesn't reach into commands/." The mirror admits the missing shared layer.
  - `packages/cli/src/bootstrap/register-tools.ts:49-73` and `register-graph-adapters.ts:44-94` — same async-discover-iterate-validate-register shape, different export keys (`tool` vs `adapter`).
- **Why it matters across packages:** Each duplication argues against itself — the helper exists, the consumer is one import away, but the lift wasn't done. Graph's four tree-sitter adapters add ~350 lines of mechanical duplication; fitness's four regex checks duplicate severity-emission code that already has bugs (Python's whole-content `split('\n').length` is O(N²); Rust's `line.match()` loses column info). New adapters will copy the closest existing pack's idiosyncrasies; new lang packs will hand-roll quote-char scanners despite the source comment forecasting exactly that. The pattern is "first-pass implementer used the helper; second-pass implementer didn't notice the helper; third-pass implementer copies the second." Five different packs reproduce the failure.
- **Recommended treatment:** Run a focused DRY pass:
  1. Migrate the four language-pack regex checks to `defineRegexListCheck` (mechanical — each declares one pattern in the `patterns` array). Fix the Python perf and Rust column-info bugs in passing.
  2. Extract `createTreeSitterParser<P>(language, moduleTag)` (and a `nameResolveCallSites` strategy with `extractTargetName`/`isReturnDiscarded` slots) into the graph engine or a `@opensip-tools/graph-tree-sitter-shared` companion. Python/Go/Java collapse to ~30-40 lines each.
  3. Lift `scanQuotedString(quoteChar)` and a max-scan constant into `core/strip-utils.ts`; migrate Python and Rust onto it. Net delta is a wash (deletes ~50 lines, adds ~25 in core) but the next lang pack is half a day instead of a day.
  4. Extract `formatBytes` / `formatDurationMs` to `@opensip-tools/cli-ui` and use from both renderer and command. Establishes the convention before the next `*-done` result ships.
  5. Extract `discoverAndRegister<TMod>({ discover, exportKey, validate, register, logEventPrefix })` in `cli/src/bootstrap/discover-helper.ts`. Both call sites collapse; the next plugin kind gets the right shape for free.
- **Priority:** Medium
- **Effort:** M (per migration; sequence as a single sprint)

### T7 — Switch-on-discriminator dispatch where a registry would fit

- **Reports flagging this:** cli (F3 — `App.tsx` 16-arm switch), fitness (F6 — three analysis-mode executors), simulation (F4 — execution-mode dispatch), graph (F14 — `executeGraph` six-output-mode god function), datastore (F1/F2/F3 — fake backend Strategy that is actually a switch + sync-only `migrate`)
- **Pattern shape:** Polymorphism-as-switch; Strategy missing
- **What's actually in the code (verified):**
  - `packages/cli/src/ui/App.tsx:36` — `switch (result.type)` with 16 arms covering `fit-done`, `list-checks`, `list-recipes`, `history`, `dashboard`, `init`, `experimental`, `sim-done`, `plugin-*`, `clear-done`, `configure-done`, `uninstall-done`, `help`, `error`, and a `default` falling through to "Unknown command result." The CLI already has a `LiveViewRegistry` (`cli-context.ts:108`) for live views — the static-render counterpart is missing.
  - `packages/fitness/engine/src/framework/define-check.ts:339-362` — `executeUnifiedCheck` dispatches `executeAnalyzeMode` / `executeAnalyzeAllMode` / `executeCommandMode` via `if/else if/else if` plus exhaustive `never`. The corresponding type guards (`isAnalyzeConfig`, `isAnalyzeAllConfig`, `isCommandConfig`) already exist in `check-config.ts`.
  - `packages/simulation/engine/src/recipes/service.ts:73-75` — ternary on `mode === 'parallel'`; `SimulationExecutionOptions.maxParallel` is declared but unused. `stopOnFirstFailure` only works for the sequential branch.
  - `packages/graph/engine/src/cli/graph.ts:99-233` — `executeGraph` is 130+ lines of `if`-chained output modes (gate-save, gate-compare, report-to-cloud, json, table, packages-fan-out).
  - `packages/datastore/src/factory.ts:4, 31` — `import { migrate } from 'drizzle-orm/better-sqlite3/migrator'` and `migrate(datastore.db, {...})`. The `backend: 'sqlite' | 'memory'` discriminator is a non-Strategy: both call `buildSqliteDataStore(...)` (verified at `backends/memory.ts:6` and `backends/sqlite.ts:10`), so the "alternative" doesn't actually exist.
- **Why it matters across packages:** These are all the same pattern: a discriminator field that screams "Strategy" and an inline switch that grows by one arm per new variant. The CLI case is the worst (third-party tool result types silently fall through to "Unknown"); the simulation case is the most actively broken (`maxParallel` and `stopOnFirstFailure` are typed but the dispatch ignores them); the datastore case is the most misleading (advertises polymorphism that doesn't exist). Each one independently invents a "switch on string" with no shared abstraction.
- **Recommended treatment:** A two-tier fix:
  1. **For dispatch tables that need extensibility** (CLI result renderer, fitness analysis modes, graph output modes, simulation execution mode) — introduce small registry/strategy patterns. The CLI gets `cli.registerResultRenderer(type, component)` mirroring `LiveViewRegistry`; tools register their own renderers in `tool.register(ctx)`. Fitness's `AnalysisModeExecutor` interface (`match(config) + execute(config, files, ctx)`); simulation's `ExecutionStrategy` (`run(scenarios, recipe, signal)`); graph's `Record<OutputMode, handler>` table.
  2. **For datastore** — decide whether the backend Strategy is real. If it's not (current truth), rename `'memory'` → `'sqlite-memory'`, delete `backends/memory.ts`, drop the `DrizzleHandle` alias, and admit "this is the SQLite store." If it is (a real second backend is planned), push `migrate(...)` into each backend's `open*Backend` function so the Open-Closed contract holds.
- **Priority:** Medium (CLI is High — third-party silently broken)
- **Effort:** M

### T8 — Declared affordances that no consumer uses (speculative generality)

- **Reports flagging this:** core (F12 — `LanguageQueryAPI`), languages (F4, F15 — `LanguageQueryAPI`, `warmup`), fitness (F1, F4, F9 — `CheckConfig.execute`, `ResolvedScope`, `legacyConfig` literal), datastore (F6 — `migrationFile`), contracts (F6 — `CliArgs`)
- **Pattern shape:** YAGNI violation; dead surface
- **What's actually in the code (verified):**
  - `packages/core/src/languages/adapter.ts:7-14, 43` — `LanguageQueryAPI<TTree, TNode>`, declared optional on `LanguageAdapter`. Only `lang-typescript/src/query.ts:16` implements it; `grep -rn 'typescriptQuery\|LanguageQueryAPI'` outside the definition + lang-typescript impl + one test returns nothing. Zero consumers.
  - `packages/core/src/languages/adapter.ts:45-46` — `warmup?(): Promise<void>` "Called by CLI bootstrap" — no CLI code path calls it; no adapter implements it.
  - `packages/fitness/engine/src/framework/check-types.ts:39` — `CheckConfig.execute` required; `isCheck()` validates it; `define-check.ts:263, 299` synthesise two identical closures. `grep -r "config\.execute"` returns only `isCheck` + tests. Never invoked.
  - `packages/fitness/engine/src/framework/define-check.ts:253, 266-276, 281-285` — `config.scope = { include: [], exclude: [], description: '' }`, `getScope()` returns `{ include: [], exclude: [], description: 'target-based scope' }`, `getMatcher()` builds a `PathMatcher` with empty includes/excludes. Migration to target-based scope happened; the legacy surface stayed.
  - `packages/datastore/src/data-store.ts:17-28` — `DataStoreMigrationError.migrationFile: string | undefined` declared but the only thrower (`factory.ts:34`) never sets it.
  - `packages/contracts/src/types.ts:65-78` — `CliArgs` marked `@deprecated` with the comment "Do not extend this interface for new flags" but still publicly exported from the barrel, and `*OptsToCliArgs` adapter functions paper over the gap.
- **Why it matters across packages:** Every one of these is a small individual cost; collectively they hide intent. A contributor reading `LanguageAdapter` sees seven members and assumes two of them are load-bearing — they aren't. A check author reading `Check` sees `getMatcher().files()` and assumes it tells them which files the check will scan — it returns empty silently. A consumer of `DataStoreMigrationError` sees `migrationFile` and tries to switch on it. The combined effect is a contract surface that's wider than the contract.
- **Recommended treatment:** A single sweep PR that retires dead surfaces:
  - Delete `LanguageQueryAPI`, `GenericFunction`, `Import` from core/languages; delete `query.ts` from lang-typescript; remove the `query?` field on `LanguageAdapter`. Reintroduce when a real consumer materialises.
  - Delete `warmup?` from `LanguageAdapter`. Reintroduce when first needed.
  - Delete `CheckConfig.execute`, the `execute` synthesis in `define-check.ts:263`, the `legacyConfig` literal at `define-check.ts:287-302`, the `execute` validator branch in `isCheck`, and `ResolvedScope`/`getScope`/`getMatcher` (or wire them to the actual scope resolver — either is fine, deletion is simpler).
  - Decide on `DataStoreMigrationError.migrationFile`: either parse Drizzle's error to populate it, or drop the field.
  - Remove `CliArgs` from the contracts barrel; replace each `*OptsToCliArgs` adapter call site with a direct per-command options pass; delete the type.
- **Priority:** Medium
- **Effort:** S-M (mechanical, but spans multiple packages)

### T9 — `process.exit` / lifecycle bypass of single-write-path invariants

- **Reports flagging this:** cli (F9 — `process.exit(2)` inside preAction bypasses `setExitCode`), cli (F11 — `setProjectContextForRun` doesn't close prior DB), fitness (F12 — `executeUnifiedCheck` swallows per-file analyze errors at debug level), simulation (F3 — `pluginLoadErrors` global hides prior errors)
- **Pattern shape:** Single-source-of-truth violation; RAII / lifecycle missing
- **What's actually in the code (verified):**
  - `packages/cli/src/cli-context.ts:158, 177-180` documents "`process.exitCode` is mutated in exactly one place (here)." `packages/cli/src/bootstrap/pre-action-hook.ts:157, 193, 245` calls `process.exit(2)` three times.
  - `packages/cli/src/cli-context.ts:53-56` — `setProjectContextForRun` sets `datastoreCache = undefined` without closing the previous handle. Same module's header concedes the in-process re-entrancy failure mode.
  - `packages/fitness/engine/src/framework/define-check.ts:114-117` — wide `catch` around `ctx.readFile` AND `config.analyze(content, filePath)`, logs at `debug` only.
  - `packages/simulation/engine/src/cli/sim.ts:62, 96-150` — module-level `pluginLoadErrors` overwritten per `ensureScenariosLoaded` call.
- **Why it matters across packages:** Each is a small lifecycle hole, but the pattern is the same: an invariant ("exit code goes through one seam", "the datastore handle is closed before reassignment", "user-bug errors surface to the result", "plugin-load errors aren't lost between calls") is local to a comment or stated in passing, and the code path that violates it is also the code path the test suite exercises less.
- **Recommended treatment:** Three coordinated changes, naturally grouped with T1:
  1. Thread `ctx.setExitCode` into the preAction hook; replace `process.exit(2)` with `setExitCode(2)` + thrown ValidationError that the existing `parseAsync().catch()` renders through `handleParseError`.
  2. When `RunScope` (T1) lands, its disposal runs `datastore.close()` deterministically.
  3. Fitness: distinguish read-errors (debug log + skip is fine) from analyze-errors (user bug — accumulate per-file errors and surface them as a result-level violation or a `runtimeErrors` array on `CheckResult`).
  4. Simulation: `pluginLoadErrors` becomes a return value of the load call, not a module global. Pairs with T1.
- **Priority:** Medium
- **Effort:** S-M

### T10 — Inconsistent authoring conventions across sibling packs

- **Reports flagging this:** fitness (F15 — pack `index.ts` conventions), languages (F3 — `parse()` return types; F7 — alias coverage; F8 — `exports` maps; F1 — subpath imports), graph (file shapes consistent but adapter-internal patterns diverge — F4/F17 boilerplate)
- **Pattern shape:** Lack of pack template / no canonical scaffolding
- **What's actually in the code (verified):**
  - `packages/fitness/checks-typescript/src/index.ts` and `checks-universal/src/index.ts` use `collectCheckObjects(allChecks)` (barrel walk); the five `checks-{python,go,rust,java,cpp}/src/index.ts` use `const checks = [singleCheck] as const`. Verified `checks-universal/src/index.ts:35-36` re-exports two individual checks "for backward compatibility" *and* exports via the collector — handled by a Style 1 + Style 2 dedup branch in `plugins/loader.ts:59-98`.
  - `packages/languages/lang-typescript/src/adapter.ts:7` does `import type { LanguageAdapter } from '@opensip-tools/core/languages/adapter.js'`; `packages/languages/lang-rust/src/adapter.ts:5` does `import type { LanguageAdapter } from '@opensip-tools/core'` (barrel). CLAUDE.md says only `parse-cache.js` is an allowed subpath exception; lang-typescript currently uses four (`/adapter.js`, `/generic-types.js`, `/parse-cache.js`, `/languages`).
  - `packages/languages/lang-rust/src/parse.ts:31`, `lang-go/src/parse.ts:21`, `lang-java/src/parse.ts:21` declare non-null return types; the contract (`core/src/languages/adapter.ts:34`) says `TTree | null`. `lang-python/src/parse.ts:21` and `lang-typescript/src/parse.ts:10` honour the contract; `lang-cpp/src/adapter.ts:25` hard-wires `parse: () => null`. Five packs, three different conventions.
  - `packages/languages/lang-java/src/adapter.ts` declares no aliases; all other packs do. Java users typing `languages: ['jvm']` get a silent no-match.
- **Why it matters across packages:** Plugin authors and new lang pack authors have no canonical template. The two-line `const checks = [singleCheck]` shape doesn't scale to two checks, so each pack rewrites its `index.ts` as soon as a second check ships. The mixed convention also forces every pack consumer (the loader) to know about both styles. The lang-typescript subpath imports keep the "exception" wording in CLAUDE.md ambiguous — either the exception covers `@opensip-tools/core/languages/*` (in which case widen the doc) or only `parse-cache.js` (in which case fix lang-typescript).
- **Recommended treatment:**
  1. Standardise pack `index.ts` on `collectCheckObjects(allChecks)` across all fitness check packs. Update the existing 5 packs (mechanical).
  2. Tighten lang-typescript's imports to the barrel; drop the `./languages/*` wildcard from `packages/core/package.json` exports. Documents the rule in code.
  3. Normalise every lang pack's `parse()` to return `XTree | null` (today's bodies can't fail, but the type matches the contract). One-line change per pack; saves a return-type churn when tree-sitter integration lands.
  4. Define and document a tiny alias policy (extension + common synonyms + adjacent siblings); decide intentionally for Java.
- **Priority:** Low-Medium
- **Effort:** S

## Findings that did NOT cross-cut

- **dashboard F4 (overlay singleton shared between Function Card and Coupling drill-down)** — real but specific to dashboard runtime; no analogue in other packages.
- **cli F8 (`executeInit` state machine)** — `init` is the only CLI command with a state-table shape; not cross-cutting.
- **graph F1 (`RuleHints` not threaded into rules)** — surfaces in T5 as the headline correctness instance of "prose contract", but the bug itself is graph-local.
- **graph F10 (`MutableStats.apply` mutates `this`)** — graph-internal Encapsulation issue; no other package has this exact shape.
- **simulation F12 (`runLoadWindow` metrics-mutation order)** — load-window-internal; not cross-cutting.
- **cli-ui findings F2/F3/F4 (Spinner/Clock standalone flag, duplicated interval logic, useClock silent zero)** — internal to the cli-ui package's React/Ink integration; doesn't recur elsewhere.
- **dashboard F11 (`paginateGroupedRows` reaches via CSS class)** — dashboard-runtime-internal coupling.
- **fitness F10 (`computePrewarmPatterns` baking in TS defaults)** — fitness-engine-internal; touches the `defaultLanguageRegistry` (T1) but the fix is local.
- **contracts F7 (`SUGGESTION_RULES` table-driven Strategy)** — explicitly called out as a *good* pattern, not a cross-cut.

## Patterns the codebase gets RIGHT across packages

Preserve these in any refactor:

- **Discriminated unions with exhaustive `never` guards.** `CommandResult` in contracts (`types.ts:172-186`), `ScenarioExecutorResult` in simulation (`framework/result-renderers.ts:106`), `CatalogVerdict` in graph. Adding a new variant is a compile error in every consumer until they add the branch.
- **Strategy/Adapter at the language boundary.** `LanguageAdapter` (six-method contract, `core/src/languages/adapter.ts`) and `GraphLanguageAdapter` (six-method contract, `graph/engine/src/lang-adapter/types.ts`) are clean Strategies with documented invariants. The dispatch (`applyContentFilter`, `pickAdapter`) is purely registry-driven; no per-language branches.
- **Builder pattern for structured outputs.** `SarifResultBuilder` in fitness (`engine/src/sarif.ts:34-81`) is a textbook fluent Builder; `ResultBuilder` for check results follows the same shape.
- **Marker-based plugin discovery.** `discoverPackagesByMarker` in core (`plugins/marker-discovery.ts:69`) is a single walker; `discoverToolPackages`, `discoverGraphAdapterPackages`, `discoverScenarioPackages`, `discoverCheckPackages` are thin typed wrappers over it. The walker doesn't know about fitness or simulation. (T6 recommends extracting one more helper for the post-discovery register loop; the discovery itself is exemplary.)
- **`MinimalTextTree` Bridge.** `core/src/languages/text-tree.ts` is the right model for "shared primitive, distinct identity per consumer" — four lang packs delegate, each can grow real AST independently. Contrast with `LanguageQueryAPI` (T8) which has the same shape but zero adopters.
- **`graph-catalog.ts` as a true contracts type.** Producer (`@opensip-tools/graph`) and consumer (`@opensip-tools/dashboard`) both depend on `contracts`; contracts owns the JSON-on-disk shape independent of either. The "MUST NOT import" comment is load-bearing.
- **`mountResultCommand` helper.** Removes the json-vs-Ink branch from every CLI command body (`packages/cli/src/commands/mount-result-command.ts:50-93`). The `--json` short-circuit lives in one place.
- **C-family scanner family.** `core/strip-utils.ts` (`scanRegularString`, `scanLineComment`, `scanBlockCommentNonNesting`, `scanBlockCommentNesting`, `scanCharLiteral`) — Template Method done right; four lang packs compose them with language-specific outer logic. The shared layer is purely language-agnostic by construction.
- **`runOneCheck` lifecycle factoring in fitness.** Per-check timeout / abort / retry / success/error dispatch in one function with a documented invariant about abort sources, pinned by a test.
- **`LiveViewRegistry`** as the seam for tool-owned live renderers. Tools register; the CLI dispatches by string key. T7's recommendation is "do this same thing for static renderers" — i.e. praise for this seam.
- **`runStage` in graph orchestrate.** Uniformly threads progress events, pressure-monitor checks, and timing across every stage. Right level of abstraction.

## Recommended sequencing

The themes interlock — done out of order, some create rework. Suggested order:

1. **T8 (delete dead affordances)** — pure subtraction, no design decisions. Removes noise that obscures the harder changes. Effort: S-M.
2. **T2 (consolidate registries)** — must come before T1 because the unified `Registry<T>` is part of `RunScope`. Cleans up the `IdNameTagRegistry` / `RecipeRegistry` sibling generalisations and the `SimulationRecipeRegistry` LSP violation in passing. Effort: M.
3. **T4 (move tool-shaped code to the right layer)** — `Signal` to contracts, `SessionRepo` out of contracts, `maybeOpenDashboard` off `ToolCliContext`. These are independent of T1 and clear the way for T3 (a re-typed `ToolCliContext` is harder to do twice). Effort: M.
4. **T3 (generic ToolCliContext / CallSiteRecord)** — once T4 has removed the "what even lives where" ambiguity, the generic parameters land cleanly. Effort: S generics, M migration.
5. **T1 (RunScope / lifecycle)** — the keystone change; depends on T2's registries and T4's `PostRunHookRegistry`. Closes off T9's lifecycle holes naturally. Effort: L.
6. **T7 (dispatch tables)** — best done after T1 because the CLI's `ResultRendererRegistry` is a `RunScope` consumer. The fitness and simulation Strategy refactors are independent. Effort: M.
7. **T5 (replace prose contracts with code)** — graph's `RuleHints` fix is the urgent piece (S, can be done independently and immediately). Dashboard runtime bundling is the big win and stands alone (M-L). Completion generation and globalExcludes consolidation can land any time. Mixed effort.
8. **T6 (DRY pass)** — mechanical; effort lives in the breadth, not the depth. Best done late so the new abstractions live next to the consolidated registries and lifecycle. Effort: M.
9. **T10 (pack conventions)** — cosmetic relative to the others; ride it into T6's PR or its own. Effort: S.

**If only one PR can land:** ship T1 + T2 together. They collapse the most reports (4–5 themes worth of follow-ons) and unblock the SaaS-mode invariant CLAUDE.md asserts.

**If only one quick win:** graph F1 / T5 — pass `adapter.ruleHints` to `rule.evaluate(...)` at `orchestrate.ts:189-201`. One-line correctness fix that ends silent regex misfires in three language adapters. Add the drift test alongside.

## Notes

- **Per-package report correction:** the contracts audit F5 claims that CLAUDE.md says the `Tool` contract lives in contracts. Verified the opposite: CLAUDE.md line 24 attributes the Tool contract to `core`, which matches the code (`packages/core/src/tools/types.ts:185`). The doc-vs-code mismatch is in `packages/contracts/src/index.ts:1-19` only — the package's own header says "the typed seam between Tools and the runner," which is misleading given that `Tool` and `ToolCliContext` live in core. The recommendation (rename the package mission to "CLI surface contracts") still stands; the diagnosis just needs adjusting.
- The graph F6 finding (SARIF render imports `@opensip-tools/fitness`) is a real layer-crossing peer-to-peer dependency (verified at `graph/engine/src/render/sarif.ts:11`). It's listed under T4 as a tool-shaped-code-in-the-wrong-layer instance, but the right fix is a new `@opensip-tools/sarif` package — neither the source nor destination today is the long-term home. Plan-of-record per the graph audit.
- Three themes (T1, T2, T9) share the same root cause: the codebase has never had a `Host` / `RunScope` / `Session` object to hang per-invocation state on. Almost every other finding in the registry / lifecycle / cast-erasure family is downstream of that absence. If only one architectural primitive is added in the next major bump, it should be this one.
- The dashboard's HTML-emitter-as-strings architecture (T5) is the only place in the codebase where a refactor would shift a meaningful surface area of code; everywhere else the recommendations are local refactors of < 200 LOC each. The dashboard runtime-bundling move is M-L on its own but it's also the highest-leverage change in the dashboard package by a large margin.
- Several per-package reports flag duplicated _comments_ as a smell ("two files have ~10-line comments explaining where globalExcludes are applied"; "every emitter file declares top-level names that later emitters reference"). This is a useful heuristic for "the type system is doing too little work here" — when the comment exists to enforce an invariant, the invariant is a candidate for a type or a function signature.
- I did not audit test files for design problems — focus was production code. The per-package reports are similarly scoped. Test infrastructure quality looks high (fakes, fixtures, snapshots) but the lifecycle-state findings (T1, T9) all leak into how tests are written, so a test-layer audit after the T1 RunScope work would be worthwhile.

## Resolution

T1 (RunScope / lifecycle) and T2 (consolidated registries) were
implemented together — the "ship T1 + T2 in one PR" recommendation
from the "Recommended sequencing" section was taken. Tracked in
`docs/plans/ready/architecture-runscope-and-registry/` (Phases 0–7);
landed in PR #2 on 2026-05-27.

**Architectural deltas (verified at HEAD of `feat/runscope-and-registry-rebased`):**

  - `RunScope` lives in `@opensip-tools/core/lib/run-scope.ts`. Owns
    per-invocation logger / parseCache / projectContext / datastore
    thunk / tool registry / language registry / recipe-config slot.
    Bound to the current async context via `AsyncLocalStorage`
    (`runWithScope` / `enterScope` / `currentScope`).
  - `Registry<T>` base in `@opensip-tools/core/lib/registry.ts`. Closed
    `DuplicatePolicy` union (5 variants). Nine registries migrated:
    `ToolRegistry`, `LanguageRegistry`, `RecipeRegistry`,
    `CheckRegistry`, `TargetRegistry`, `FitnessRecipeRegistry`,
    `SimulationRecipeRegistry`, `GraphAdapterRegistry`,
    `GraphRulesRegistry`. `IdNameTagRegistry` deleted entirely.
  - `defaultToolRegistry` / `defaultLanguageRegistry` module-singleton
    exports gone — tools read `cli.scope.tools` / `cli.scope.languages`.
  - `defineX` no longer registers as a side effect; callers register
    explicitly via the plugin loader. `*WithoutRegistration` twins
    deleted (47 LOC of test surface).
  - `Symbol.for(globalThis)` recipe-config slot replaced by scope-bound
    `RecipeCheckConfigSlot`. Two-copies-of-fitness invariant verified
    by `packages/fitness/engine/src/recipes/__tests__/check-config.test.ts`
    and the SaaS-mode smoke test at
    `packages/cli/src/__tests__/saas-mode-smoke.test.ts`.
  - Logger free mutators (`setLogLevel`, etc.) replaced by
    `configureLogger(opts)`.
  - `lang-typescript filterCache` folded into
    `LanguageParseCache.filteredContent`.
  - `SimulationRecipeRegistry`'s LSP violation fixed (built-ins via
    `{ internal: true }`).

**Metrics (LOC):**

  - Whole-file deletions: 178 LOC (`id-name-tag-registry.ts` + its test).
  - `WithoutRegistration` test surface: 47 LOC.
  - Free mutator exports: net −2 (6 removed, 4 added — of which 2 are
    renames and 2 take an explicit `RunScope` parameter rather than
    closing over module state).
  - Total registry LOC: 1182 → 1292 (per-tool registries shrank from
    1182 → 1060; new `Registry<T>` base added 232). The "≤ 600" target
    in the original report was miscalibrated — each per-tool registry
    retains a legitimate domain-specific index (`byExtension`,
    `byAlias`, etc.) that doesn't generalise into the base.
  - Greps return zero in live `src/` for: `IdNameTagRegistry`,
    `defaultToolRegistry`, `defaultLanguageRegistry`,
    `Symbol.for(...opensip-tools...)`, `setLogLevel`, `WithoutRegistration`.

**Themes resolved:** T1, T2. T9 (lifecycle holes) is partially closed
by the RunScope lifecycle; remaining items not blocked by registries
or per-run state stand on their own.

Full metric tables and per-task evidence are in
`docs/plans/ready/architecture-runscope-and-registry/phase-7-verification.md#findings`.
