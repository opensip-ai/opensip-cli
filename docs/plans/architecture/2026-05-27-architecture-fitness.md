# Architecture audit — fitness

**Date:** 2026-05-27
**Scope:** packages/fitness/engine, packages/fitness/checks-*
**Auditor:** Claude

## Summary

The fitness namespace is the largest and most architecturally interesting tool
in the monorepo. The engine has been refactored into a respectable kernel
(framework + recipes + targets + sarif/gate + plugin loader) and pays
attention to several patterns (Builder for results, Strategy for path
matching, Template Method for `defineRegexListCheck`, Factory for recipe
construction). However, the audit surfaces a cluster of design issues that
weaken the engine/check-pack contract and create real misuse hazards for
plugin authors.

Headline findings:

1. **The `Check` abstraction is doubly-wired and partially-dead.** Every
   `Check` exposes both `config.execute(ctx)` (declared on `CheckConfig`,
   structurally required by `isCheck()`) and `check.run(cwd, options)`,
   but only `check.run` is ever called by the engine. The `execute`
   field is dead surface that every check synthesises and every type
   guard validates. This is an "Interface Segregation / Single
   Responsibility" violation that imposes cost on every check pack
   author and every isCheck() consumer.
2. **`getCheckConfig` uses a `globalThis` symbol slot** as a back-channel
   from the recipe service into checks. The comment explains it ("two
   copies of fitness can be loaded"), but it is a textbook Service
   Locator anti-pattern: implicit dependency, mutable global state, no
   test isolation guarantee beyond the single-session contract. Checks
   should receive their config through the `ExecutionContext`.
3. **Cross-pack regex check inconsistency.** `defineRegexListCheck`
   exists in the engine to unify the regex-scan pattern, yet the
   `checks-{python,go,rust,java}` packs each open-code their own
   line/match loop with subtly different shape (Rust uses
   `line.match()` and drops column info; Python uses whole-content
   exec; Go uses per-line exec). Five identical-shape sites,
   five different bugs waiting to diverge.
4. **`defineCheck` re-canonicalises and re-validates the config on
   every Check construction but discards information**: the
   `ResolvedScope { include, exclude, description }` is hard-coded to
   empty strings, and the `PathMatcher` returned by `getScope()` /
   `getMatcher()` is constructed with empty include/exclude every
   time — making both APIs structurally useless.
5. **`FileCache` is a process singleton with a 10-minute auto-clear
   timer**, used by every check and every directive-processing scan.
   This works today because exactly one recipe runs at a time, but the
   coupling is invisible to plugin authors: any check that calls
   `fileCache.get()` directly is silently coupled to recipe lifecycle.

Other findings cover the polymorphism opportunity in three
analysis-mode executors, the file-cache→ignore-processing coupling, the
duplicated `legacyConfig` construction in `defineCheck`, the
`prewarmPatterns` mode-detection heuristic, the `globalExcludes`
double-application logic, the scope-resolver's two-mode resolution
function, and consistency gaps in how check packs declare scope.

The recipe execution pipeline (parallel/sequential schedulers ->
`runOneCheck` -> `processSuccessResult`/`processErrorResult`) is in
genuinely good shape — the recent refactor that pulled the per-check
lifecycle into a shared `runOneCheck` is a clean Template Method
factoring and the documented invariant about abort sources is
exemplary.

## Findings

### F1 — `CheckConfig.execute` is dead surface area

- **Files:** `packages/fitness/engine/src/framework/check-types.ts:20-40,62-75`, `packages/fitness/engine/src/framework/define-check.ts:245-264,287-300`
- **Principle/Pattern:** Interface Segregation, Single Responsibility, YAGNI
- **Status:** Problematic
- **Evidence:**
  - `check-types.ts:39` — `CheckConfig.execute: (ctx: ExecutionContext) => Promise<CheckResult>` is required on every `Check.config`.
  - `check-types.ts:71` — `isCheck()` validates `typeof config.execute === 'function'`.
  - `define-check.ts:263` synthesises one closure, `define-check.ts:299` synthesises a *second identical* closure for `legacyConfig`, neither is ever invoked.
  - `grep -r "config\.execute"` across `packages/fitness/` returns only the `isCheck` validator and tests. No call site exists.
- **Why it matters:** The `Check` interface advertises two execution entry points but only one (`check.run`) is real. Plugin authors writing `isCheck`-shaped tests against the public type will dutifully add an `execute` field that is never called; future maintainers will be confused about which one is canonical. The double-construction in `defineCheck` (the second `legacyConfig` literal inside `run`) is pure ceremony — it allocates a config object only to feed it to a no-longer-existent `createExecutionContext` overload.
- **Recommendation:** Remove `execute` from `CheckConfig`, drop the `typeof config.execute === 'function'` test from `isCheck`, and delete the second `legacyConfig` literal in `define-check.ts`'s `run` method. The `Check` abstraction should expose exactly one boundary — `run(cwd, options)` — and `config` should be pure metadata.

### F2 — `getCheckConfig` is Service-Locator via `globalThis`

- **Files:** `packages/fitness/engine/src/recipes/check-config.ts:47-121`, `packages/fitness/engine/src/recipes/service.ts:122,175`
- **Principle/Pattern:** Dependency Inversion, Service Locator anti-pattern
- **Status:** Problematic
- **Evidence:**
  - `check-config.ts:47` — `const GLOBAL_KEY = Symbol.for('@opensip-tools/fitness/currentRecipeCheckConfig')`.
  - `check-config.ts:53-55` — `function slot(): GlobalSlot { return globalThis as unknown as GlobalSlot }`.
  - `service.ts:122` — `setCurrentRecipeCheckConfig(recipe.checks.config)` at the start of a run.
  - `service.ts:175` — `clearCurrentRecipeCheckConfig()` in the `finally`.
  - The 40-line JSDoc on `GLOBAL_KEY` explains the "two copies of fitness loaded" justification — it is real, but the result is still ambient mutable state read implicitly by checks.
- **Why it matters:** Checks declare a dependency on per-recipe config implicitly by importing `getCheckConfig`. This dependency is invisible at the call site, untyped at the boundary, and impossible to test in isolation without setting up the global slot. The two-copies-of-fitness problem is real, but the solution chosen — store on `globalThis` under a `Symbol.for` key — is the same anti-pattern that fails in larger systems (no test isolation between concurrent runs, no replay, no DI seam for mocking, no compile-time visibility of what data each check reads).
- **Recommendation:** Add an optional `recipeCheckConfig?: Readonly<Record<string, unknown>>` slice to `ExecutionContext` (or a typed `recipeContext` field). The recipe service already constructs the context — pass the per-slug slice in there. Keep `getCheckConfig` as a back-compat shim that reads from the context (when available) and falls back to the global slot. Document the global slot as a transitional escape hatch for plugin packs imported under a parallel `@opensip-tools/fitness` resolution.

### F3 — Five regex-list reimplementations that should use `defineRegexListCheck`

- **Files:** `packages/fitness/checks-python/src/checks/no-bare-except.ts:18-41`, `packages/fitness/checks-go/src/checks/no-fmt-print.ts:15-41`, `packages/fitness/checks-rust/src/checks/no-dbg-macro.ts:20-42`, `packages/fitness/checks-universal/src/checks/no-todo-comments.ts:16-41`, `packages/fitness/checks-universal/src/checks/file-length-limit.ts` (different shape, but same family), and the engine's `framework/define-regex-list-check.ts` which exists for exactly this case.
- **Principle/Pattern:** DRY, Template Method
- **Status:** Problematic
- **Evidence:**
  - Python (`no-bare-except.ts:25-41`): runs regex against the full content and computes line numbers via `content.slice(0, match.index).split('\n').length` — O(N²) on multi-match files.
  - Go (`no-fmt-print.ts:25-40`): splits into lines, runs regex per line, manually resets `lastIndex`.
  - Rust (`no-dbg-macro.ts:29-41`): uses `line.match(pattern)` which discards column information.
  - Universal `no-todo-comments.ts:25-41`: splits into lines, manual `lastIndex = 0`, manual `exec` loop.
  - All four duplicate the same iteration shape and severity-emission code that `defineRegexListCheck` already implements once, with options for comment-skip, test-file-skip, and one-per-line semantics.
- **Why it matters:** Each pack will continue to drift. Rust's `line.match` already lost column info, and Python's whole-content scan has a different performance profile from the others. New language packs will copy the closest existing pack's idiosyncrasies. The engine has the right abstraction (`defineRegexListCheck`); the check packs are simply not using it. The audit prompt's question — "do they all look the same shape?" — gets a literal "no" here.
- **Recommendation:** Migrate the language-pack regex checks to `defineRegexListCheck`. The Python case in particular needs converting because the full-content scan with `split('\n').length` is a real perf liability that nobody will notice until a long file ships. The migration is mechanical — each check declares one pattern in the `patterns` array.

### F4 — `defineCheck` hard-codes a dead `ResolvedScope` and a useless `PathMatcher`

- **Files:** `packages/fitness/engine/src/framework/define-check.ts:253,266-276,281-285`
- **Principle/Pattern:** Single Responsibility, dead code / leaky abstraction
- **Status:** Problematic
- **Evidence:**
  - `define-check.ts:253`: `scope: { include: [], exclude: [], description: '' }` — every check's `config.scope` is empty.
  - `define-check.ts:266-268`: `getScope()` returns `{ include: [], exclude: [], description: 'target-based scope' }`.
  - `define-check.ts:270-276`: `getMatcher()` constructs a `PathMatcher` with empty includes/excludes.
  - The actual file selection happens through `buildScopeBasedFileMap` in `scope-resolver.ts`, which reads `check.config.checkScope` (the new semantic scope), not `config.scope`.
- **Why it matters:** Three public methods on `Check` (`config.scope`, `getScope()`, `getMatcher()`) return zero-information stubs because the resolution model migrated to scope-based targets but the legacy surface was never deleted. Any plugin author who calls `check.getMatcher().files()` to "see what this check will scan" gets an empty array — silently wrong, never an error. The `ResolvedScope` interface itself only has one real consumer left.
- **Recommendation:** Either delete `ResolvedScope`/`getScope()`/`getMatcher()` (preferred — they have no real callers) or change them to actually delegate to the target registry / scope resolver. The empty-string `description: ''` on `config.scope` is the clearest tell that this object is a placeholder.

### F5 — `FileCache` is a hidden singleton with lifecycle coupling

- **Files:** `packages/fitness/engine/src/framework/file-cache.ts:37-205,210`, `packages/fitness/engine/src/framework/execution-context.ts:208,212`, `packages/fitness/engine/src/framework/ignore-processing.ts:82,249,274`
- **Principle/Pattern:** Dependency Inversion, Singleton anti-pattern, implicit coupling
- **Status:** Problematic
- **Evidence:**
  - `file-cache.ts:210` — module-level `export const fileCache = new FileCache()`.
  - `execution-context.ts:208` — `readFile` delegates to `fileCache.get(filePath)` (not `fs.readFile`).
  - `ignore-processing.ts:82,249,274` — directive scanning reads from `fileCache.get` directly.
  - `file-cache.ts:179-192` — there is a 10-minute `setTimeout` auto-clear, `unref`'d so it doesn't keep the process alive.
- **Why it matters:** Every plugin check that calls `ctx.readFile` is implicitly bound to the recipe service's lifecycle (`fileCache.prewarm` at start, `fileCache.clear` at end in `service.ts:177`). A plugin author who calls `fileCache.get` directly (it is exported via `engine/src/index.ts:36`) is doubly bound. The auto-clear timer is a leak-defence against the singleton being orphaned; the existence of that timer is evidence that the lifecycle contract is fragile. There is no way to run two recipes concurrently, no way to test a check with a controlled file system without monkey-patching the singleton.
- **Recommendation:** Move the file cache onto `ExecutionContext` (already passed to every check), or wrap it in a `FileAccessor`-like interface registered in `FitnessRecipeServiceConfig`. Keep the module-level `fileCache` export as a back-compat shim for the directive-scanning path but document that direct use is discouraged. Deleting the 10-minute timer is then safe because lifecycle is explicit.

### F6 — Three analysis-mode executors begging for polymorphism

- **Files:** `packages/fitness/engine/src/framework/define-check.ts:85-191,339-362`
- **Principle/Pattern:** Polymorphism over conditionals, Strategy
- **Status:** Missing opportunity
- **Evidence:**
  - `executeAnalyzeMode`, `executeAnalyzeAllMode`, `executeCommandMode` are three sibling functions with the same shape: build `ResultBuilder`, iterate something, convert violations to signals, return.
  - `executeUnifiedCheck` (line 339) dispatches across them via `if/else if/else if` plus an exhaustive `never` check.
  - `check-config.ts` already has `isAnalyzeConfig`, `isAnalyzeAllConfig`, `isCommandConfig` type guards.
- **Why it matters:** Adding a fourth analysis mode (e.g. `analyzeProject` for true workspace-level analysis, or `analyzeStreaming` for very large files) requires editing `executeUnifiedCheck`'s branch chain, adding a type guard, adding a config schema, and writing a fourth executor function. The current shape is a Strategy waiting to happen but is implemented as a switch. The recipe service has a related comment at `service.ts:151-157` about tabularising the 2-mode parallel/sequential ternary "when 3rd mode lands" — exactly the same observation, exactly the same shape.
- **Recommendation:** Introduce an `AnalysisModeExecutor` interface with `match(config): boolean` and `execute(config, files, ctx): Promise<CheckResult>`. Register the three current executors in an array and let `executeUnifiedCheck` iterate. The Zod `UnifiedCheckConfigSchema`'s "exactly one mode" guard becomes "exactly one executor matches" — same invariant, more extensible shape. Low priority; only worth doing the moment a fourth mode is on the roadmap.

### F7 — `globalExcludes` are applied in two places with subtly different semantics

- **Files:** `packages/fitness/engine/src/framework/execution-context.ts:131-184`, `packages/fitness/engine/src/framework/scope-resolver.ts:152-163,182-227`
- **Principle/Pattern:** Single Source of Truth, Don't Repeat Yourself
- **Status:** Problematic
- **Evidence:**
  - `scope-resolver.ts:88-103` — `preResolveAllTargets` applies globalExcludes to every target's pre-resolved file list.
  - `execution-context.ts:141-151,178-180` — `createMatchFilesFunction` *also* applies globalExcludes, but only to the `fileCache.paths()` fallback path (scope-empty checks).
  - The comment at `scope-resolver.ts:192-194` says "When resolvedTargets is provided, globalExcludes are pre-applied — skip re-filtering" — and the comment at `execution-context.ts:166-171` says "Per-check target files take priority over cache. These are already filtered by globalExcludes during target pre-resolution".
- **Why it matters:** The fact that both files have ~10-line comments explaining "where globalExcludes are applied" and "why we don't re-apply them" is itself evidence of architecture smell. The invariant is "globalExcludes are applied exactly once on every code path" but it is enforced by three distinct branches in two files, each documented separately. Anyone refactoring either file without reading the other risks double-filtering or skipped-filtering. The minimatch instances are compiled twice (once per path) for the same patterns.
- **Recommendation:** Make globalExcludes a property of the resolved file lists, not a flag threaded through three layers. One approach: have `buildScopeBasedFileMap` always return excluded files, and have the fileCache fallback path consult the same `Map<slug, files>` rather than `fileCache.paths()`. Then `globalExcludes` is applied exactly once, at target pre-resolution time, and `execution-context.ts` doesn't need to know about it.

### F8 — `CheckRegistry` silent-drop on duplicate `register`

- **Files:** `packages/fitness/engine/src/framework/registry.ts:21-36`
- **Principle/Pattern:** Fail-fast, Principle of Least Surprise
- **Status:** Problematic
- **Evidence:**
  - `registry.ts:25-28` — `if (this.checks.has(key)) { /* Silently skip duplicate */ return; }`
  - Contrast: `FitnessRecipeRegistry` (`recipes/registry.ts:91-99`) routes duplicates through `throwOnDuplicate: true` by default.
- **Why it matters:** Two plugins shipping the same `slug` (one bare, one namespaced) silently fall into a first-wins behaviour with no diagnostic, even with `logger.warn` available. The `resolve()` method later logs a warning when an ambiguous lookup happens — but only at lookup time, not at registration time, so an unused-but-shadowed check is invisible. This is the inverse policy from recipes, which throws.
- **Recommendation:** Either log at registration time (cheap, no behaviour change) or align with `FitnessRecipeRegistry`'s policy and reject duplicates by default. The current "silently skip" message in the comment ("same check imported multiple times") is true for the same-id case but obscures the genuinely-different-checks-with-same-slug case.

### F9 — `defineCheck` constructs a duplicated `legacyConfig` literal inside `run`

- **Files:** `packages/fitness/engine/src/framework/define-check.ts:287-302`
- **Principle/Pattern:** DRY, dead code
- **Status:** Problematic
- **Evidence:**
  - Lines 246-264 already build a `Check.config` that includes `execute`, `slug`, `tags`, `description`, etc.
  - Lines 287-300 build a *second* object literal with the same fields (`id`, `slug`, `tags`, `description`, `scope`, `itemType`, `docs`, `disabled`, `timeout`, `scansFiles`, `execute`) just to pass to `createExecutionContext`.
  - `createExecutionContext` only reads `id`, `slug`, `itemType` (see `execution-context.ts:114-119`).
- **Why it matters:** Anyone editing `BaseCheckConfig` has to remember to update both places. The "legacy" name in the variable says someone planned to remove it; it has not been removed.
- **Recommendation:** Replace the entire `legacyConfig` literal with `createExecutionContext({ id: config.id, slug: config.slug, itemType: config.itemType ?? 'files' }, cwd, matcher, options)`. Three fields, no rebuilt object. Then the duplicate `execute` closure on line 299 also goes away.

### F10 — `computePrewarmPatterns` is a mode-detection heuristic that can over-prewarm

- **Files:** `packages/fitness/engine/src/recipes/service.ts:44-57,269-272`
- **Principle/Pattern:** Open/Closed, separation of intent and policy
- **Status:** Problematic
- **Evidence:**
  - `service.ts:44-57` — if ANY check is "universal" (no fileTypes), prewarm `DEFAULT_PREWARM_PATTERNS` (ts/tsx/js/jsx/json/md), else union all fileTypes.
  - `DEFAULT_PREWARM_PATTERNS` is hard-coded in `file-cache.ts:215` to TS/JS/JSON/MD — there is no `.py`, `.go`, `.rs`, `.java`, `.cpp`.
  - The plugin model says new language packs ship with `fileTypes: ['py']` etc., so a Python-only run with one Python check correctly prewarms `**/*.py` — but the moment a single universal check (`no-todo-comments`, `file-length-limit`) is added, the prewarm jumps to the TS-centric default and *misses* the `.py` files entirely. The Python check then has to re-read them on demand.
- **Why it matters:** This is the system's biggest architectural inconsistency. The whole point of the language-adapter abstraction is to make the engine language-agnostic, but the prewarm step bakes in TS-flavoured defaults at the engine layer. A Python-only project running a fitness recipe with `no-todo-comments` gets a slower first run than the same project without `no-todo-comments`, which is the opposite of the intended optimisation.
- **Recommendation:** Have `DEFAULT_PREWARM_PATTERNS` driven by `defaultLanguageRegistry` — union of every registered language adapter's `fileExtensions`. The kernel already knows the answer; the file-cache module hard-codes a stale snapshot.

### F11 — `FitnessRecipeRegistry` constructor does I/O

- **Files:** `packages/fitness/engine/src/recipes/registry.ts:46-65,67-75`, `recipes/registry.ts:140`
- **Principle/Pattern:** Constructor-does-no-work, Dependency Inversion
- **Status:** Problematic
- **Evidence:**
  - `registry.ts:50-65` — constructor calls `registerBuiltInRecipes()` and `loadAndRegisterUserRecipes(...)` (currently a stub, but the architecture supports it).
  - `registry.ts:140` — `export const defaultRecipeRegistry = new FitnessRecipeRegistry({ logWarnings: false })` — built-ins are pre-loaded at module import time.
- **Why it matters:** Constructors that do work (filesystem traversal, registration loops, log emission) make testing and re-initialisation awkward. The current `reset()` method (`registry.ts:117-120`) exists precisely because of this — tests need a way to undo what the constructor did. The user-recipes stub at `registry.ts:77-84` will, if filled in, make the constructor genuinely async-shaped (or force a sync I/O hack).
- **Recommendation:** Move built-in registration to a factory function `createDefaultRecipeRegistry()`. The class constructor takes zero work. The default-singleton export becomes `export const defaultRecipeRegistry = createDefaultRecipeRegistry()`. Tests can create fresh instances without the `reset()` dance.

### F12 — `executeUnifiedCheck` swallows per-violation errors silently

- **Files:** `packages/fitness/engine/src/framework/define-check.ts:103-118`
- **Principle/Pattern:** Error handling, fail-loud
- **Status:** Problematic
- **Evidence:**
  - `define-check.ts:114-117` — when `ctx.readFile` or `config.analyze` throws (not abort, anything else), the framework logs at `debug` level and continues.
  - The comment says "Skipping unreadable file" but the catch is wider — it catches every exception from `config.analyze(content, filePath)` too, including bugs in the user check.
- **Why it matters:** A check author who writes `analyze: (content) => content.thing.that.is.undefined` will see the check pass with zero findings on every file; the actual error is hidden at `debug` level. There is no signal in `CheckResult` that the analyze function exploded on N files. The audit prompt called out "error handling in user-authored check `analyze` functions" specifically — this is the failure mode.
- **Recommendation:** Distinguish read errors (file truly unreadable — debug log + skip is correct) from analyze errors (user bug — should surface as a violation or a result-level warning). Either re-throw the analyze error so it shows up in `processErrorResult`, or accumulate per-file errors and add them to the `ResultBuilder` as a single "N files errored during analysis" violation.

### F13 — `Check.run` resilience and `executeUnifiedCheck`'s match-file phase

- **Files:** `packages/fitness/engine/src/framework/define-check.ts:278-327,339-362`
- **Principle/Pattern:** Single Responsibility, abstraction boundary
- **Status:** Problematic
- **Evidence:**
  - `define-check.ts:343` — `executeUnifiedCheck` calls `ctx.matchFiles()`.
  - `define-check.ts:346` — then `filterFilesByType(matchedFiles, config.fileTypes)`.
  - These two steps are conceptually file-selection; the analysis-mode executors below only consume the resolved `files` array. The Match+Filter phase doesn't belong inside the mode-dispatch switch.
- **Why it matters:** Adding a fourth analysis mode (F6) re-runs the same Match+Filter setup. Three modes today already inline-duplicate the filter call by virtue of being reached through this single funnel; if any of them needed different file selection semantics, the funnel breaks.
- **Recommendation:** Lift Match+Filter out of `executeUnifiedCheck`. The function becomes `executeUnifiedCheck(config, files, ctx)` — pure dispatch, no I/O. `Check.run` performs Match+Filter once and hands the resolved file list down. Helps F6 land cleanly.

### F14 — `RecipeService` and `runOneCheck` reach across the lifecycle boundary

- **Files:** `packages/fitness/engine/src/recipes/run-one-check.ts:111-113`, `packages/fitness/engine/src/recipes/service.ts:177-179`
- **Principle/Pattern:** Liskov / well-defined abort semantics
- **Status:** Correct, but unusually fragile
- **Evidence:**
  - `run-one-check.ts:99-110` — long comment block explaining that the per-check AbortController is only ever aborted by the local setTimeout, and that any other abort source would break timeout detection.
  - `service.ts:178` — `this.abortController?.abort()` is in the `finally` block, separate from the per-check controllers.
  - The invariant is pinned by a test (`runOneCheck.test.ts`, mentioned in the comment).
- **Why it matters:** The abort model is documented and works, but it is held together by an invariant that lives in three separate files (per-check controller, scheduler observation, recipe-level controller) and is only enforced by a comment + test. The audit prompt asked about async semantics — this is the area to flag.
- **Recommendation:** Tag the per-check abort with a typed reason (`controller.abort(new TimeoutError(...))`) and let `runOneCheck` read `controller.signal.reason` instead of inferring "abort means timeout". This makes the invariant local to the file and removes the cross-file comment dependency. Low priority — the current shape is correct — but it's a real future-fragility hazard.

### F15 — Per-pack `checks` collection mixes two authoring conventions

- **Files:** `packages/fitness/checks-typescript/src/index.ts:13-22`, `packages/fitness/checks-universal/src/index.ts:13-37`, `packages/fitness/checks-python/src/index.ts:1-3`, `packages/fitness/checks-go/src/index.ts:1-3`, `packages/fitness/checks-rust/src/index.ts:1-3`, `packages/fitness/checks-java/src/index.ts:1-3`, `packages/fitness/checks-cpp/src/index.ts:1-3`
- **Principle/Pattern:** Consistency / Principle of Least Surprise
- **Status:** Problematic
- **Evidence:**
  - The TS and universal packs use `collectCheckObjects(allChecks)` (walks the barrel recursively).
  - The five language-specific packs hand-write `const checks = [singleCheck] as const`.
  - The universal pack additionally re-exports two individual checks (`index.ts:35-36`) "for convenience / backward compatibility" while also exporting them via the collector.
- **Why it matters:** Three different shapes for the same plugin-contract obligation. A new pack author has no canonical example to copy from. The universal pack's mixed shape (collector + named re-exports) gets handled by `registerFitExports` in `plugins/loader.ts:59-98` via the "Style 1 + Style 2" dedup-by-id branch — that dedup logic exists *because* of this inconsistency.
- **Recommendation:** Standardise on `collectCheckObjects(allChecks)` for every pack. The two-line `const checks = [singleCheck] as const` form is fine for single-check packs but it does not scale to two checks, so the moment a second check ships, the pack rewrites its index. Pick one shape now.

### F16 — `defineRegexListCheck` and `defineCheck` validate at different layers

- **Files:** `packages/fitness/engine/src/framework/define-regex-list-check.ts:283-318`, `packages/fitness/engine/src/framework/check-config.ts:287-317`
- **Principle/Pattern:** Liskov, validation completeness
- **Status:** Problematic
- **Evidence:**
  - `defineCheck` runs the full `UnifiedCheckConfigSchema.parse` (`check-config.ts:316`).
  - `defineRegexListCheck` accepts `DefineRegexListCheckConfig` (interface only — no Zod), synthesises a `defineCheck` config, then *that* is validated. The pattern-list itself (`RegexListCheckPattern[]`) is unvalidated at runtime.
- **Why it matters:** A plugin author who passes `patterns: [{ id: 'not-a-uuid', slug: 'BAD_SLUG', regex: /foo/, message: '' }]` gets undefined behaviour: the slug-formatting/UUID-validation that defineCheck does for top-level fields never runs on per-pattern entries. The check still loads, runs, and emits violations with the malformed pattern.slug as the `type` field.
- **Recommendation:** Validate `RegexListCheckPattern[]` with a Zod schema in `defineRegexListCheck`, matching the slug+UUID format defineCheck requires. Surface validation errors at construction time, same as defineCheck does.

### F17 — `SarifResultBuilder` is good, but lives next to a `Record<string, unknown>` return type

- **Files:** `packages/fitness/engine/src/sarif.ts:34-81,84-86`
- **Principle/Pattern:** Builder, type-safety at boundaries
- **Status:** Correct (Builder), Missing opportunity (return type)
- **Evidence:**
  - `sarif.ts:34-81` — fluent Builder with `withSeverity`, `withLocation`, `withFix`, `build` — well done.
  - `sarif.ts:84` — `buildSarifLog(output: CliOutput): Record<string, unknown>` — the SARIF doc is typed as a generic object.
  - `gate.ts:266-269` — re-defines `SarifDoc` interface to consume what `buildSarifLog` produces.
- **Why it matters:** Producer and consumer of the SARIF log are decoupled at the type level. Either could change without the other noticing. The builder pattern at the result level shows the team knows how to do this right; the top-level should match.
- **Recommendation:** Type `buildSarifLog` as `SarifLog` (define the interface) and share it with `gate.ts`. Same logic, exact same code shape — just a return type change.

### F18 — `FitnessRecipeService.createAdHocRecipe` is a top-level static that does ad-hoc state mapping

- **Files:** `packages/fitness/engine/src/recipes/service.ts:318-373`
- **Principle/Pattern:** Single Responsibility, Factory
- **Status:** Problematic
- **Evidence:**
  - 56-line static method on the service class that converts CLI args into a `FitnessRecipe`.
  - The branching (`if args.check && includes '*'/'?'`, `else if args.check`, `else if args.tagFilters?.length`, `else`) is recipe-builder logic that has nothing to do with the service.
- **Why it matters:** The service class is meant to *execute* recipes. Building one from CLI args is a separate concern that belongs in a free function or a builder class. Today, if a non-CLI caller wants the same conversion, they have to call `FitnessRecipeService.createAdHocRecipe` — coupling test code and programmatic users to a class whose constructor they don't want to pay for.
- **Recommendation:** Move `createAdHocRecipe` out of the service class and into `recipes/ad-hoc-recipe.ts` (or wherever fits). The static-on-class shape is a remnant of an earlier design where the service owned more state.

## Strengths

- **`runOneCheck` is exemplary.** The per-check lifecycle (timeout, abort, retry, success/error dispatch) is factored into a single function with a documented invariant about abort sources. Parallel and sequential schedulers delegate cleanly. This is the right shape and the documentation pins it in place.
- **`Check` registry's namespaced-slug + bare-slug index** is a thoughtful two-map structure that handles collision diagnostics well (warn at lookup, not silent first-wins).
- **`gate.ts`'s `ViolationIdentity` strategy** is a clean Strategy: default identity is sha256-of-(file,rule,message), callers can substitute a different identity without forking the comparator. Good extensibility seam.
- **`buildScopeBasedFileMap` deduplicates glob work** across targets correctly — one glob pass per unique pattern, then per-target assembly. The performance shape matches what the code's comments promise.
- **`SarifResultBuilder` is a textbook Builder** with `with*` chainable methods and a `build()` terminator. Type-safe, hard to misuse.
- **Recipe selector resolution** (`check-resolution.ts`) is a clean discriminated-union dispatch with an `_exhaustive: never` guard. The author's reply to "why not tabularise" is right.
- **`memoryProfiler` is a focused singleton with one job** and is one of the rare places where a singleton is actually fine — it captures process-wide RSS at known instants. Worth noting given how much I've complained about other singletons above.

## Notes

- The `@fitness-ignore-file` annotations sprinkled through engine source
  (e.g. `define-check.ts:1-2`, `service.ts:1-2`, `recipes/registry.ts:1-3`)
  are evidence that the engine modules are themselves violating their
  own fitness checks. That is not inherently a problem (the engine
  needs to do things that user code shouldn't), but it suggests several
  rules (`module-coupling-metrics`, `file-length-limit`) are tuned for
  application code and the engine should ship its own per-rule
  exemptions or carve the rules into "applies to checks vs applies to
  engine" tiers.
- The directive system (`ignore-processing.ts`, `directive-parsing.ts`,
  `directive-inventory.ts`) is large enough to warrant its own audit
  pass. I've left it out of this one because the bulk is correct and
  the lifecycle is local to filterSignalsByDirectives, but the file
  cache coupling at `ignore-processing.ts:82,249,274` is worth
  cross-referencing F5.
- The `tool.ts` (fitness-as-Tool plugin descriptor) is small and clean
  — no findings there. Same for `targets/loader.ts`, `signalers/`,
  and `persistence/baseline-repo.ts`.
- Several findings (F1, F4, F9) describe the same vestigial layer:
  `CheckConfig.execute`, the empty `ResolvedScope`, and the
  `legacyConfig` literal are all leftover from an earlier execute-
  driven design. A single cleanup PR can collapse all three at once.
