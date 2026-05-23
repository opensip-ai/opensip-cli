---
status: current
last_verified: 2026-05-22
title: "Architecture audit — @opensip-tools/fitness"
package: "@opensip-tools/fitness"
audience: [contributors, architects]
---
# Architecture audit — @opensip-tools/fitness

## Summary

`@opensip-tools/fitness` is the largest package in the workspace
(roughly 6.4k LOC of `src/`, before tests) and the centre of gravity
for the platform: it owns `defineCheck`, the recipe service, the
gate, the SARIF builder, the target resolver, the plugin loader, the
content filter, and the `fitnessTool` Tool plugin. The shape is in
good order overall — a clear three-layer split into
`framework/` (check primitives), `recipes/` (orchestration), and
top-level concerns (`gate.ts`, `sarif.ts`, `cli/`, `targets/`,
`plugins/`, `signalers/`) — and several GoF patterns are present,
correctly applied: Registry (`CheckRegistry`,
`FitnessRecipeRegistry`, `TargetRegistry`), Builder (`ResultBuilder`),
Strategy (`PathMatcher`), Template Method (`defineCheck` wraps the
user's `analyze` function inside the framework's lifecycle), and
Factory (`createSignal` via `core`, `CheckInfoFactory`).

The sturdy pieces are `framework/check-config.ts` (Zod-validated
discriminated union), `framework/registry.ts` (small, focused,
namespace-aware), `recipes/types.ts` and `recipes/check-resolution.ts`
(exhaustively-typed selector dispatch), and the gate's content-keyed
diff (line-shift-invariant by design).

The most substantive findings concern (a) the analysis-mode dispatch
in `define-check.ts` — three near-identical `executeXxxMode`
functions chained behind an `if`-cascade plus an `executeUnifiedCheck`
type-guard chain, which is begging for a Strategy/Map-of-Strategies
refactor; (b) the `severity-mapping.ts` long `switch` over tag
strings (primitive-obsession); (c) `executeFit` (612 lines) doing
config resolution, language validation, scope-map building, recipe
selection, callback wiring, output formatting, persistence, and exit
decisions in a single function; (d) the recipe-`config` map
projected into `globalThis` — module-singleton state with a
single-session contract that the type system can't help enforce;
(e) the parallel/sequential split duplicating most of the per-check
lifecycle (timeout setup, retry, error/success dispatch); (f) the
gate's hashing strategy hard-coded inline (filePath + ruleId +
message), with no seam for a different identity function; and (g)
the SARIF "builder" being a free function that walks `output.checks`
inline rather than a real Builder.

Everything below is a finding worth acting on, ordered roughly by
impact on contributor velocity (top) to nice-to-haves (bottom).

## Existing patterns (correct usage)

- **Registry** is consistent across the package: `CheckRegistry`
  (`framework/registry.ts`), `FitnessRecipeRegistry`
  (`recipes/registry.ts`), `TargetRegistry`
  (`targets/target-registry.ts`). All three follow the same shape —
  `register`, `get`, `has`, `list`, `size`, `clear` — and expose a
  default singleton (`defaultRegistry`, `defaultRecipeRegistry`,
  no default for targets because they're config-loaded). The
  `CheckRegistry` adds a thoughtful namespace layer (primary store
  `namespace:slug` plus a reverse `bareSlug → keys[]` index, with
  collision warning).
- **Builder** is correctly applied in `framework/result-builder.ts`:
  `ResultBuilder` is a fluent, single-responsibility constructor of
  `CheckResult` with `totalItems`, `filesScanned`, `addSignal(s)`,
  `ignoredCount`, `duration`, `extra`, `build`, `buildError`. The
  `buildInfo` private decision (compliance vs violations format)
  encapsulates that branching cleanly.
- **Strategy** is correctly applied in `framework/path-matcher.ts`
  (the file's own jsdoc names the pattern). `PathMatcher` is a
  reusable strategy with composition methods (`withExcludes`,
  `typescriptOnly`, `noTests`).
- **Template Method.** `defineCheck` constitutes a Template Method:
  the framework owns the lifecycle (validate config → match files →
  filter by file types → run analysis → filter signals by directives
  → build CheckResult / wrap errors), and the user supplies the
  variable step (`analyze` / `analyzeAll` / `command`).
- **Factory** is used at two levels: `createSignal` (in `core`,
  consumed by `define-check.ts`'s `toSignal`), and `CheckInfoFactory`
  in `types/findings.ts` for `compliance` / `violations` info objects.
- **Discriminated union with exhaustive switch.** Both
  `getAnalysisMode` (in `framework/check-config.ts`) and
  `resolveChecks` (in `recipes/check-resolution.ts`) use the
  `_exhaustive: never` idiom to make the compiler reject any new
  selector / mode without a corresponding branch. This is the right
  pattern for closed unions.
- **Layering.** Imports flow `fitness → core` and `fitness →
  contracts` only; `cli` is downstream. The fitness package never
  imports from a check pack or the CLI. The one documented exception
  (`lang-typescript` imports `filterContent` from fitness) is a
  legacy back-edge surfaced in `CLAUDE.md`, not a violation
  introduced here.
- **Frozen / immutable defaults.** `defineRecipe` returns
  `Object.freeze(recipe)`, the targets loader freezes every produced
  config, and the signalers loader uses `structuredClone` as a
  deep-freeze (the comment in `signalers/loader.ts` calls this out).
  Recipe results and check configs are read-only by type.
- **Lifecycle cleanup discipline.** `FitnessRecipeService.executeRecipe`
  has a `try/finally` that clears the recipe-config map, parse
  cache, file cache, and aborts any outstanding controller — exactly
  the right shape for a stateful orchestrator.
- **Anti-recursion in directive processing.** The `isSignalIgnored`
  rule in `framework/ignore-processing.ts` ("never suppress signals
  pointing at directive lines") is a genuinely subtle invariant
  encoded directly in code with the explanation in the function's
  JSDoc. This is exemplary.

## Findings

### 1. `define-check.ts` analysis-mode dispatch is Strategy in disguise

- **Files / code:**
  `packages/fitness/engine/src/framework/define-check.ts:86-189` (the
  three `executeXxxMode` functions),
  `packages/fitness/engine/src/framework/define-check.ts:315-336`
  (`executeUnifiedCheck` — the dispatcher).
- **Pattern / principle:** Strategy / Map-of-Strategies. The current
  shape is three top-level functions
  (`executeAnalyzeMode`, `executeAnalyzeAllMode`, `executeCommandMode`)
  with near-identical preludes (build a `ResultBuilder` with
  `checkId` + `itemType`, `.totalItems(files.length)`,
  `.filesScanned(...)` ), chained behind an `if (isAnalyzeConfig) /
  else if (isAnalyzeAllConfig) / else if (isCommandConfig) / else
  exhaustive` cascade. Adding a fourth mode means editing the
  dispatcher AND the type guard family AND adding a new
  `executeFooMode` that has to remember the boilerplate prelude.
- **Status:** Issue — the cascade is currently small enough to read,
  but the duplication has already been written three times and the
  ResultBuilder boilerplate now lives in three places. A new
  contributor wiring up a fourth mode (e.g. `analyze-incremental`)
  has to find all the touch points themselves.
- **Why it matters:** Open/Closed. Three modes today; the codebase
  comments mention more (`audit`, `lint`, `bench` per `CLAUDE.md`).
  Each new mode is N edits to the central dispatcher, which is
  exactly what Strategy is supposed to localise.
- **Recommendation:** Define a `CheckExecutor` interface (single
  `execute(config, files, ctx): Promise<CheckResult>` method) and
  a `Map<'analyze' | 'analyzeAll' | 'command', CheckExecutor>`. The
  dispatcher becomes `executors[getAnalysisMode(config)].execute(...)`.
  Move the ResultBuilder prelude into a small helper
  (`createBaseBuilder(config, fileCount)`). This is a low-risk
  refactor — the public surface (`defineCheck`) doesn't change. The
  exhaustiveness check moves from the if-cascade to a missing
  map entry, which TypeScript catches as readily.

### 2. `severity-mapping.ts` long `switch` is primitive obsession on tag strings

- **Files / code:**
  `packages/fitness/engine/src/framework/severity-mapping.ts:29-56`.
- **Pattern / principle:** Primitive Obsession / Lookup-Table.
  `mapTagsToSignalCategory` does a linear scan over a check's tag
  strings, then a nested 7-arm `switch` to map the first matching
  tag to a `SignalCategory`. The tag strings are stringly-typed —
  there's no compiler relationship between "the tags a check
  declares" (`readonly string[]`) and "the categories the signaler
  knows about" (`SignalCategory`).
- **Status:** Issue — small, isolated, but every new tag/category
  pair touches this `switch`. Worse, the function silently falls
  back to `'warning'` when no tag matches, which means typos in
  check tags ("perfomance" instead of "performance") downgrade a
  perf finding to a generic warning with no signal in the logs.
- **Why it matters:** Two things. First, the table-driven
  alternative is shorter, declarative, and supports static analysis
  of "is every category reachable" / "are there orphan tags". Second,
  the silent fallback is a quality-of-results bug — checks that pass
  through this mapping have a hidden coupling to the spelling
  conventions baked here.
- **Recommendation:** Replace the `switch` with a frozen lookup
  table:
  ```typescript
  const TAG_TO_CATEGORY = Object.freeze<Record<string, SignalCategory>>({
    security: 'security',
    performance: 'performance',
    architecture: 'architecture',
    quality: 'warning',
    resilience: 'resilience',
    testing: 'testing',
    documentation: 'documentation',
  });
  ```
  Iterate `for (const tag of tags) if (tag in TAG_TO_CATEGORY) return TAG_TO_CATEGORY[tag];`.
  Optionally log a `warn` once per process when a check's tags
  contain none of the known categories, so the silent fallback is
  surfaced at startup rather than buried per-finding.

### 3. `executeFit` is a 612-line function doing eight things

- **Files / code:** `packages/fitness/engine/src/cli/fit.ts:327-612`.
- **Pattern / principle:** Single Responsibility. The function
  currently performs: (1) plugin & check loading via
  `ensureChecksLoaded`, (2) recipe-name validation, (3) two config
  loads with shared error handling, (4) language-adapter validation
  against the targets config, (5) `buildScopeBasedFileMap`, (6)
  ad-hoc vs named-recipe selection, (7) `FitnessRecipeService`
  callbacks wiring, (8) `CliOutput` shaping, (9) session
  persistence, (10) table-row building, (11) summary building,
  (12) `failOnErrors` / `failOnWarnings` thresholding,
  (13) findings list building, and (14) result return. The
  function bears an `// eslint-disable-next-line
  sonarjs/cognitive-complexity` directive at its top — the linter
  has already noticed.
- **Status:** Issue — material to contributors. This function is the
  primary entry point for adding a new fit feature; new flags get
  threaded here and the file keeps growing.
- **Why it matters:** Function-level fan-in. This is the single
  function called by both `fitnessTool.register` (for direct fit)
  and `runGateMode` (for gate-save / gate-compare). The bigger it
  gets, the more bugs it carries that only one entry-point notices.
- **Recommendation:** Extract phases as named, narrowly-typed
  helpers:
  - `loadFitConfig(args, cwd) → { signalersConfig, targetsConfig, targetRegistry }` (with the error-result early-return).
  - `validateLanguagesAgainstAdapters(targetRegistry, langRegistry) → void` (the warning block).
  - `selectRecipe(args, recipeName) → FitnessRecipe | { error: ErrorResult }` (ad-hoc vs named selection).
  - `buildCliOutput(fitnessResult, recipeName, args) → CliOutput`.
  - `buildFitDoneResult(output, signalersConfig, fitnessResult, args) → FitDoneResult`.
  Keep `executeFit` as the orchestration shell that calls these in
  order. Each helper has one reason to change and one set of tests
  to update.

### 4. `recipes/check-config.ts` smuggles state through `globalThis`

- **Files / code:**
  `packages/fitness/engine/src/recipes/check-config.ts:44-86`,
  consumed at `framework/define-check.ts` (via the per-check
  `getCheckConfig<T>(slug)` API) and set/cleared by
  `recipes/service.ts:122,168`.
- **Pattern / principle:** Avoid hidden global state. The file's
  comment is admirably honest: it explains that the runtime
  frequently has two copies of `@opensip-tools/fitness` loaded (the
  CLI's bundled copy and the plugin pack's resolved copy), so a
  module-local `let` would silently break the projection. The fix
  shipped is `globalThis[Symbol.for('@opensip-tools/fitness/currentRecipeCheckConfig')]`.
- **Status:** Trade-off taken with eyes open. The comment explains
  the failure mode that drove the choice. But this is still
  process-shared singleton state with a soft "single-session"
  contract enforced only by `executeRecipe` throwing
  `SESSION_IN_PROGRESS`.
- **Why it matters:** Two failure modes the type system can't catch.
  (a) Embedders that run two `FitnessRecipeService` instances in
  parallel (e.g. a watcher + an on-demand run) will trample each
  other's config map. The contract throws on overlap, but only
  inside one service instance — across instances there's no guard.
  (b) Any check that captures `getCheckConfig(slug)` at module load
  rather than inside `analyze` reads whichever value is set at
  import time; the comment recommends "once at module load" but
  nothing prevents it. A misuse silently drops the per-check
  augmentation.
- **Recommendation:** Long-term, plumb the config through
  `ExecutionContext` (`ctx.checkConfig: Readonly<Record<string, unknown>>`)
  rather than module-singleton state. The plumbing is O(1) per
  check and removes the shared mutable slot entirely. This is a
  larger refactor; near-term, add a runtime guard inside
  `setCurrentRecipeCheckConfig` that throws when the slot is
  already populated and not being explicitly cleared, so the
  "two services in parallel" misuse fails fast.

### 5. Parallel and sequential executors duplicate the per-check lifecycle

- **Files / code:**
  `packages/fitness/engine/src/recipes/parallel-execution.ts:57-220`
  vs
  `packages/fitness/engine/src/recipes/sequential-execution.ts:27-139`.
- **Pattern / principle:** Strategy on the *driver* (parallel vs
  sequential), not on the *unit of work*. Both files independently
  re-implement the same per-check lifecycle: build
  `ProcessorContext`, set up `AbortController`, set
  `setTimeout` for the recipe-or-check timeout, wrap
  `check.run(...)` in `executeWithRetry`, dispatch to
  `processSuccessResult` / `processErrorResult` based on
  abort/result state, surface `shouldStop`. The shapes diverge in
  small ways (parallel's window-management vs sequential's
  `for-of`), but the *check execution unit* is structurally
  identical and exists twice.
- **Status:** Issue — every change to per-check timeout/abort/retry
  semantics must be made in two places, and the two have already
  drifted (parallel uses a chained-promise dispatch with `.then /
  .catch / .finally`; sequential uses `try/catch`).
- **Why it matters:** Real-world divergence. The parallel branch's
  abort path checks `checkAbortController.signal.aborted` *after*
  `executeWithRetry` resolves; the sequential branch keeps a
  separate `timedOut` flag. Both work today, but a contributor
  fixing a bug in one will need to remember the symmetric fix in
  the other — and won't, because nothing tells them.
- **Recommendation:** Extract a `runOneCheck(check, opts, ctx):
  Promise<RunOutcome>` function (with `RunOutcome = { kind:
  'success' | 'error', ...}`). Both executors then become
  scheduling shells: parallel does sliding-window dispatch, sequential
  does `for-of`. Inside each, after `runOneCheck` resolves,
  forward to `processSuccessResult` or `processErrorResult` and
  honour `shouldStop`. Same lifecycle, two schedulers.

### 6. Gate hashing is wired inline, with no seam for an alternate identity

- **Files / code:**
  `packages/fitness/engine/src/gate.ts:243-245` (the
  `hashViolation` function), called inside
  `extractViolationsFromCliOutput` (`gate.ts:247-263`) and
  `extractViolationsFromSarif` (`gate.ts:287-319`).
- **Pattern / principle:** Strategy. The gate's headline property
  ("line-shift-invariant identity — line numbers are intentionally
  NOT in the matching key") is enforced by a single hard-coded
  `createHash('sha256').update(filePath + '\n' + ruleId + '\n' +
  message)` call. There is no `IdentityStrategy` / hashing
  function passed in, no overload, no pluggable comparator.
- **Status:** Issue — small but visibly limiting. Real users hit
  cases where (a) the message contains an absolute path that
  changes between hosts (CI vs local), so the same logical
  violation hashes differently, (b) they want to ignore the
  message entirely (rule-id+filePath identity), or (c) they want
  rename-resilient identity (rule-id+message only). Today they
  must fork the gate.
- **Why it matters:** A single function-strategy parameter would
  make this configurable without changing the gate's other
  semantics. The comment at the top of the file documents the
  identity choice explicitly, which is precisely the kind of
  decision Strategy exists to reify.
- **Recommendation:** Lift `hashViolation` into a parameter:
  ```typescript
  type ViolationIdentity = (v: { filePath: string; ruleId: string; message: string; line?: number }) => string;
  const DEFAULT_IDENTITY: ViolationIdentity = (v) =>
    createHash('sha256').update(`${v.filePath}\n${v.ruleId}\n${v.message}`).digest('hex');
  export function compareToBaseline(output: CliOutput, baselinePath: string, identity: ViolationIdentity = DEFAULT_IDENTITY): GateCompareResult { ... }
  ```
  The default behaviour is unchanged; advanced users (or future
  recipes for cross-host stability) plug in a custom identity.

### 7. SARIF "builder" is an inline walker, not a real Builder

- **Files / code:**
  `packages/fitness/engine/src/sarif.ts:33-86` (`buildSarifRuns`),
  `sarif.ts:98-139` (`chunkSarifRuns`).
- **Pattern / principle:** Builder pattern. `buildSarifRuns` is a
  single function that iterates `output.checks`, builds a
  per-check `ruleIds: Set<string>` and `results: Record<string,
  unknown>[]`, then constructs a `SarifRun` literal at the end of
  each check loop. The `result` object is built field-by-field with
  conditional `region.startLine = f.line` / `region.startColumn =
  f.column` /`result.locations = [...]` / `result.fixes = [...]`.
  `Record<string, unknown>` is the result type — every field is
  loosely typed.
- **Status:** Issue — the typing is anaemic and the construction is
  hard to extend. Today SARIF carries `ruleId`, `message`,
  `level`, `locations`, `fixes`. Adding a new SARIF field
  (`partialFingerprints`, `properties.tags`, `relatedLocations`)
  means another conditional block inside the same loop, sharing
  a `Record<string, unknown>` with everything else. The chunker
  later has to reach into `r.ruleId as string` to recover types.
- **Why it matters:** Primitive obsession on `Record<string,
  unknown>`. The SARIF spec is a closed schema; a typed builder
  would catch typos and missing required fields.
- **Recommendation:** Introduce a typed `SarifResult` interface
  (mirroring the `SarifResult` *consumer* type already declared in
  `gate.ts:265-275`!) and a `SarifResultBuilder` with
  `withLocation(filePath, line?, column?)`, `withFix(suggestion)`,
  `withSeverity(severity)`, `build(): SarifResult`. Pull the
  consumer types from `gate.ts` into a shared `sarif/types.ts` so
  the producer and consumer agree by construction (today they
  describe the same shape independently).

### 8. `fitnessTool.register` is one of the longest tool registrations in the workspace

- **Files / code:**
  `packages/fitness/engine/src/tool.ts:92-217` (the `register`
  function and the `runGateMode` helper at `:223-278`).
- **Pattern / principle:** Single Responsibility / Configuration vs
  Behaviour. `register()` does Commander wiring for four
  subcommands (`fit`, `dashboard`, `fit-list`, `fit-recipes`), an
  18-flag `.option()` block on `fit` alone, then the action
  handler dispatches between gate-mode / list / list-recipes /
  json / live-render / open-dashboard branches inline.
- **Status:** Issue — same shape as Finding 3, scaled down. Each
  subcommand has its own constants block (`FIT`, `DASHBOARD`,
  `FIT_LIST`, `FIT_RECIPES`), but the wiring code reaches into
  Commander directly instead of being driven from the descriptor.
- **Why it matters:** Adding a new subcommand requires editing
  `register()`, and the descriptor metadata
  (`ToolCommandDescriptor`) is currently wasted — it's used for
  conflict detection but not to drive the wiring it describes.
- **Recommendation:** Extract one `registerXxxCommand(program, cli)`
  function per subcommand (`registerFitCommand`,
  `registerDashboardCommand`, `registerListCommand`,
  `registerRecipesCommand`). The action handler for `fit` should
  itself extract the dispatch tree (`runGateMode` already exists;
  add `runListMode`, `runRecipesMode`, `runJsonMode`, `runLiveMode`
  as sibling helpers). `register()` becomes a 6-line orchestrator.

### 9. `CheckSelector` discriminated union — dispatch is correctly typed but spread across two files

- **Files / code:** `recipes/types.ts:28-62` (the union),
  `recipes/check-resolution.ts:19-40` (the dispatcher), with
  per-selector resolvers at `:42-142`.
- **Pattern / principle:** Strategy vs typed switch. Today's shape
  is a typed switch with an `_exhaustive: never` guard. The four
  resolvers (`resolveExplicitSelector`, `resolvePatternSelector`,
  `resolveTagsSelector`, `resolveAllSelector`) are top-level
  functions sharing a `buildMatchTargets(slug, registry)` helper.
- **Status:** Working, but is the pattern asking for polymorphism?
  Probably no, today. The selectors are pure functions of selector
  → registry → slugs; they share `buildMatchTargets` cleanly; the
  exhaustiveness check is sound; and the union has been stable for
  a while. A class hierarchy would add ceremony for no payoff.
- **Why it matters:** This is a place to make the *non*-call:
  discriminated-union + exhaustive switch is the right shape when
  the strategies are stateless and small, and the fitness package
  knows it. Don't change this; document the decision so the next
  contributor doesn't "fix" it into a class hierarchy.
- **Recommendation:** Add a comment at the top of `check-resolution.ts`:
  *"This file is intentionally a typed switch over the
  `CheckSelector` union, not a polymorphic strategy hierarchy.
  Selectors are pure, stateless, share helpers, and benefit from
  the compiler's `_exhaustive: never` check on close. Adding a new
  selector requires a one-line edit here and the union — that's the
  intended cost."* — same trade-off, but now load-bearing.

### 10. `tool.ts` `initialize: async () => {}` is a documented no-op masking real wiring elsewhere

- **Files / code:** `tool.ts:292-298` (the no-op `initialize`),
  with the real wiring inside `cli/fit.ts:105-171`
  (`ensureChecksLoaded` — module-singleton `checksLoaded` boolean,
  `pluginLoadErrors` array, `mergedCheckDisplay` map).
- **Pattern / principle:** Lifecycle responsibility. The `Tool`
  contract has both `initialize` (lifecycle hook) and `register`
  (wiring hook). Today `register` mounts commands; the *real*
  startup work (plugin loading, check-package discovery, display
  lookup rebuild) is inside `ensureChecksLoaded`, which is called
  lazily by the action handlers (`executeFit`, `listChecks`,
  `listRecipes`, `openDashboard`). The state is in module-scope
  variables in `cli/fit.ts`, not on the tool instance.
- **Status:** Trade-off taken — the tool.ts comment explains it:
  "ensureChecksLoaded() is called inside the executeFit /
  listChecks / listRecipes paths, so a separate initialize() pass
  is not strictly needed today." But the pre-load hook setter
  (`setPreLoadHook`) AND the load-error array (`pluginLoadErrors`)
  AND the display merge AND the `checksLoaded` boolean are all
  module-singleton state in `cli/fit.ts`.
- **Why it matters:** Two embedder failure modes the contract
  doesn't catch. (a) An embedder that constructs *two*
  `fitnessTool` clones (e.g. for A/B-tested recipe runs) shares
  `checksLoaded` / `pluginLoadErrors` across both — the second
  clone's `executeFit` returns "no plugins" silently because the
  first's already populated the singleton. (b) Tests that need to
  reset state between cases must reach into `cli/fit.ts`'s
  module-private vars.
- **Recommendation:** Move `checksLoaded`, `pluginLoadErrors`, the
  `mergedCheckDisplay` map, and `preLoadHook` onto a
  `FitnessRuntime` object owned by `fitnessTool`. `initialize`
  builds it; `executeFit` reads from it. Keep the module-level
  exports (`ensureChecksLoaded`, `setPreLoadHook`,
  `getPluginLoadErrors`) as facade wrappers for backwards compat.
  Each `fitnessTool` instance then has its own runtime.

### 11. `directive-parsing.ts` and `directive-inventory.ts` re-implement comment-opener detection

- **Files / code:**
  `framework/directive-parsing.ts:34-48` and `:71-76` (the
  `COMMENT_OPENERS` table — `//`, `/*`, `<!--`, `#`, with lengths)
  vs
  `framework/directive-inventory.ts:54-55` (which only handles
  `// ` and `/* `).
- **Pattern / principle:** DRY. Two parsers, two opener lists, two
  conventions: `directive-parsing.ts` accepts four comment families
  (line, block, HTML, hash); `directive-inventory.ts` accepts two
  (line, block). The inventory file's purpose is exactly to read
  back the directives that the parser respects. Today's inventory
  silently misses HTML and hash directives that the parser
  honoured.
- **Status:** Issue — the inventory underreports. A doc file with
  `<!-- @fitness-ignore-file foo -->` will *be* ignored by the
  filter, but `collectFileIgnoreDirectives` in
  `ignore-processing.ts` won't surface it in the directive
  inventory because `parseDirectiveLine` only matches `// ` / `/* `
  prefixes. Users running `--findings` with directive auditing
  will see "directives applied: 0" while the file is in fact
  suppressed.
- **Why it matters:** Behaviour drift between two parsers that
  ought to share a single comment-opener table. Asymmetric
  comment-opener handling is exactly the kind of subtle bug that
  costs a Friday afternoon to find.
- **Recommendation:** Hoist the `COMMENT_OPENERS` table into a
  shared module (e.g. `framework/comment-openers.ts`) and have
  both parsers consume it. Add a test that asserts a `# `,
  `// `, `/* `, and `<!-- ` directive all (a) suppress and (b)
  surface in the inventory.

### 12. `FitnessRecipeService.start` returns a recipe-result via throw rather than `Result<T,E>`

- **Files / code:** `recipes/service.ts:95-109` (the public
  `start`), with two `// @fitness-ignore-next-line
  result-pattern-consistency` directives suppressing the
  workspace's own check.
- **Pattern / principle:** Error-handling consistency. The package
  ships a fitness check (`result-pattern-consistency`) that
  encourages `Result<T, E>` returns at boundaries. The service's
  public entry point chooses to throw `SystemError` for
  `SESSION_IN_PROGRESS` and `NotFoundError` for an unknown recipe
  — both of which are precondition failures that `executeFit`
  catches and re-shapes as `ErrorResult`.
- **Status:** Trade-off taken — the suppression comments name it
  "infrastructure boundary, throw is appropriate". The judgment is
  defensible: precondition failures are a different category from
  domain errors. But the suppression is repeated, which suggests
  the rule's heuristic is fighting a real seam.
- **Why it matters:** Either the service is the right place for
  `Result<T, E>` (and the wrapper `executeFit` should propagate it
  unchanged), or it isn't (and the rule should learn this seam).
  Today's mid-position — throw at boundary, catch one layer up,
  re-shape into `ErrorResult` — is the worst of both worlds because
  the type doesn't tell you which errors come back as exceptions
  and which as data.
- **Recommendation:** Pick a side and document it in the package's
  README. If the chosen side is "service throws on precondition
  failures, returns `FitnessRecipeResult` on success", say so on
  the `start` JSDoc (it already lists `@throws`, but could be more
  emphatic) and update the rule's exception list to recognise
  service-class boundaries by convention rather than by per-call
  suppression. If the chosen side is `Result<T, E>`, lift the
  `try/catch` from `executeFit` into the service and return
  `Result<FitnessRecipeResult, FitnessError>`.

### 13. `dashboard.ts` includes a hand-rolled YAML extractor for `dashboard.editor`

- **Files / code:** `cli/dashboard.ts:70-92`
  (`extractDashboardEditor` — a line-walker regex parser).
- **Pattern / principle:** DRY / Single Source of Truth. The
  fitness package already has two YAML loaders
  (`signalers/loader.ts` and `targets/loader.ts`) using
  `js-yaml` + Zod. Dashboard chooses to hand-roll a regex
  line-walker to avoid the import.
- **Status:** Issue — an avoidable third config-reading code path,
  and a brittle one. The regex is anchored on `^dashboard\s*:\s*$`,
  doesn't handle quoted block keys, comment-only lines next to the
  block, or YAML's tab handling. It works for the canonical case
  and will silently miss edge cases.
- **Why it matters:** Future contributors adding fields under
  `dashboard:` (e.g. `dashboard.theme`, `dashboard.openCommand`)
  will reach for `extractDashboardEditor` as the precedent and
  duplicate the regex pattern. The right precedent is the existing
  loader.
- **Recommendation:** Either (a) extend `SignalersConfigSchema` to
  include `dashboard: z.object({ editor: z.string().optional() }).optional()`
  and let `loadSignalersConfig` carry the value, or (b) thin out
  `extractDashboardEditor` into a `js-yaml` + nullable lookup,
  matching the pattern used by `readCheckPackagePreferences`
  (which also reads YAML inline but uses `js-yaml` rather than
  regex).

### 14. `LRUCache` in `file-accessor.ts` duplicates infrastructure that lives in `core`

- **Files / code:** `framework/file-accessor.ts:21-59` (the
  `LRUCache<K, V>` class), used at `:81` to cache file contents
  for `analyzeAll`-mode checks.
- **Pattern / principle:** Layering / DRY. The implementation is
  the textbook "delete + re-set on get; evict oldest on full"
  Map-based LRU. The class is private to the file (good), but the
  *concept* is platform-level — `core` already has a `parse-cache`
  with similar semantics, and other packages (e.g. the
  `content-filter`'s timer-based cache) re-roll their own.
- **Status:** Trade-off taken — the LRU is small (40 lines) and
  unit-tested by virtue of its consumer. But the package now has
  three caches (`fileCache`, `parseCache`, `LRUCache` here, plus
  the timer-based `filterCache` in `content-filter.ts`), each with
  its own eviction story.
- **Why it matters:** The four caches are the single biggest
  source of "memory leaks if you forget the lifecycle" risk in
  fitness. Service.executeRecipe correctly clears `fileCache` and
  `parseCache` in its `finally`; the `filterCache` self-evicts on a
  10-minute idle timer; the LRU evicts on capacity. Four
  strategies, three of which are bespoke.
- **Recommendation:** Lift a `BoundedCache<K, V>` into `core` with
  three eviction policies (`capacity`, `idle-timeout`, `manual`),
  and have all four caches in fitness consume it. Lifecycle
  cleanup (registered `clear` callbacks the recipe service calls
  in its `finally`) becomes the single uniform pattern.

### 15. Two `getLineNumber` exports with the same name and different signatures

- **Files / code:**
  `framework/result-builder.ts:209-211` (`getLineNumber(content,
  index): number` — content + char index),
  `framework/ast-utilities.ts:30-33` (`getLineNumber(node,
  sourceFile): number` — TS node + source file).
- **Pattern / principle:** API hygiene / least-surprise. The barrel
  exports the latter as `getASTLineNumber` (an explicit rename),
  but inside the framework the two coexist under the same identifier.
  `ast-utilities.ts`'s file comment notes the rename and explains
  it.
- **Status:** Working today, but a real footgun for grep-based
  navigation. Searching for `getLineNumber` in the framework
  returns two unrelated functions; only one of them is what you
  want.
- **Why it matters:** Maintainability. The fix has been
  half-shipped: the public API gets the rename, but the internals
  don't. A future contributor refactoring `result-builder.ts`
  could easily accidentally call the AST variant and ship a
  type-mismatch bug.
- **Recommendation:** Rename inside `ast-utilities.ts` to
  `getASTLineNumber` directly (no internal rename); the barrel
  re-export becomes a plain `export from`. One name, one signature,
  same place.

## Non-findings considered and dismissed

- **`CheckSelector` polymorphism vs typed switch (Finding 9 above).**
  Considered "this is crying out for polymorphism"; concluded it
  isn't. Selectors are pure, stateless, small, and share
  `buildMatchTargets`. The `_exhaustive: never` guard gives the
  same close-the-set property polymorphism would, with less
  ceremony. Recommendation is to *document* the choice, not
  change it.
- **`CheckRegistry` namespace logic complexity.** The reverse
  index + collision-warning-on-bare-slug-resolution looks fancy
  but is actually the minimal shape needed for namespaced plugins.
  Tested and small; nothing to do.
- **`PathMatcher.typescriptOnly()` and `noTests()`.** These look
  like leaky abstractions ("why does the matcher know about test
  files?"), but they're actually composition helpers used at one
  call site each — fluent shortcuts, not core primitives. Leaving
  alone.
- **`recipes/check-result-processor.ts` size (258 lines).** Looks
  long, but every function is small and named (`createCheckSummary`,
  `createErrorSummary`, `updateSessionForSuccess`,
  `updateSessionForError`, `processSuccessResult`,
  `processErrorResult`). The two public entry points are 60-ish
  lines each — comfortably within the cognitive budget. Don't split.
- **`scope-resolver.ts`'s pre-resolve-then-lookup architecture.**
  The two-phase shape (`preResolveAllTargets` builds a global
  pattern→files map; `resolveFilesForCheck` does pure lookup) was
  noted in the file's header comment and is exactly right for a
  workload where many checks share patterns. Performance-shaped
  rather than design-shaped — leave it.
- **The `/* eslint-disable @typescript-eslint/require-await */`
  in parallel-execution.ts.** The author flags this for "future
  processors that may become async". The cost (a one-line
  disable) is correctly traded against the cost of an API churn
  if the comment proves prescient. Not a finding.
- **`builtInRecipes` as a frozen array of in-file `defineRecipe(...)`
  calls.** Could be JSON, could be auto-discovered, could be
  loaded from disk. None of those would be improvements: the
  recipes are first-party, version-bound to the engine, and
  benefit from compile-time visibility. Leave alone.
- **`memory-profiler.ts` at module scope.** A singleton profiler
  per process is exactly right for the use case (process-wide
  delta tracking). Mocking concerns can be addressed by injecting
  a profiler clone into `ProcessorContext` if a test demands it,
  but no test does today.
