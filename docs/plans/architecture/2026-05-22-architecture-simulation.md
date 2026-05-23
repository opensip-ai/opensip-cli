---
status: current
last_verified: 2026-05-22
title: "Architecture audit — @opensip-tools/simulation"
package: "@opensip-tools/simulation"
audience: [contributors, architects]
---
# Architecture audit — @opensip-tools/simulation

## Summary

`@opensip-tools/simulation` (in `packages/simulation/engine/`) is the
`sim` Tool plugin. It supports four scenario kinds (`load`, `chaos`,
`invariant`, `fix-evaluation`), each with its own author-facing
`defineXxxScenario` entry point. Every kind produces a
`RunnableScenario` with a `kind` discriminator and a `run(abortSignal)`
contract that returns a `ScenarioExecutorResult` discriminated union.

The package is in good architectural shape for an experimental tool:

- The core kind-discriminator + discriminated-result-union pattern is
  cleanly applied. Dispatch sites (`renderScenarioResultView`) use
  TypeScript exhaustiveness via `_exhaustive: never` (Replace
  Conditional with Polymorphism is unnecessary because each
  `RunnableScenario` already polymorphs `run()`).
- The legacy `defineScenario` adapter is well-bounded: a single
  projection function, an explicit migration error for `chaosConfig`,
  warn-once instrumentation, and a deprecation test.
- The Strategy pattern is used correctly twice: predicates
  (`PredicateEvaluator` registry) and invariant drivers
  (`InvariantContextDeps`). Both have framework-shipped
  throw-NOT-IMPLEMENTED stubs and an explicit override path for tests.
- `RunnableScenario.run` is polymorphic — there is **no** central
  `switch (scenario.kind)` dispatch in the runtime path. The
  architecture diagram in `docs/architecture/30-the-sim-loop/02-execution-model.md`
  showing `dispatcher.execute(scenario, ctx) { switch (scenario.kind) }`
  is misleading; the actual implementation is a virtual call.

The findings below are mostly cleanup opportunities and ergonomic
fixes; none undermine the core architecture. The most impactful items
are (a) eliminating the load/chaos `runWindow` duplication (Template
Method or extracting a shared `runLoadWindow` helper), (b) reconciling
the duplicated metric-key resolver between `result-builder.ts` and
`execution-engine.ts`, and (c) deciding what the recipe Layer 2
abstraction should look like before sim grows the rest of fitness's
service capabilities.

## Existing patterns (correct usage)

- **Discriminated union over kinds (`ScenarioExecutorResult`).** The
  envelope is shared (`scenarioId`/`passed`/`durationMs`/`signals`);
  the `outcome` field carries kind-specific evidence; exhaustive
  switches surface omissions at compile time. (`framework/scenario-executor-result.ts`,
  `framework/result-renderers.ts`.)
- **Strategy via virtual-method dispatch on `RunnableScenario.run()`.**
  Each kind's `createXxxScenarioRunner()` returns a frozen object
  carrying its own closure over the kind-specific config and a `run()`
  whose return type is the matching union variant. The recipe service
  calls `scenario.run(signal)` without knowing the kind.
- **Strategy via registry (`PredicateEvaluator`, `InvariantContextDeps`).**
  Both are registries of named drivers/evaluators with framework-shipped
  stubs (throw NOT_IMPLEMENTED) and a callsite-override hook
  (`registerPredicate(...)` for fix-evaluation; `config.deps` for
  invariant). The pattern is consistent and testable.
- **Adapter for legacy alias (`defineScenario`).** `framework/define-scenario.ts`
  is a single projection function with a migration error for
  `chaosConfig.enabled`, warn-once log instrumentation, and a
  deprecation test in `legacy-define-scenario.test.ts`. The deprecated
  path exists, is reachable, but doesn't leak into the new code.
- **Generic registry (`GenericRegistry<RunnableScenario>`).** The
  cross-kind scenario registry uses the same generic registry that
  fitness uses, with name-collision protection and dual-key (id + name)
  lookup. The kind-specific selectors (`getScenariosByKind`) compose on
  top.

## Findings

### `runWindow` duplicates the load executor's loop body

- **Files / code:** `packages/simulation/engine/src/kinds/load/executor.ts:39-119` (`createStandardExecutor`); `packages/simulation/engine/src/kinds/chaos/executor.ts:36-102` (`runWindow`).
- **Pattern / principle:** DRY; Template Method pattern.
- **Status:** Real duplication. The load standard executor and the
  chaos `runWindow` share roughly 60 lines of identical structure: tick
  loop with `tickIntervalMs = 100`, `rampUpProgress` math,
  `requestsThisTick = Math.floor(currentRps / (1000 / tickIntervalMs))`,
  identical 95% success heuristic, identical `LatencyTracker` snapshot
  application. The chaos version inserts a chaos-active branch but is
  otherwise a copy.
- **Why it matters:** Every change to the simulation loop (e.g. a real
  RPS scheduler, real persona action dispatch, observability hooks) has
  to be made in two places. A `runSimulationLoop` already exists in
  `framework/execution/execution-engine.ts` but neither kind uses it —
  it's set up for a richer ExecutorContext that the new kinds don't
  produce.
- **Recommendation:** Extract a `runLoadWindow(config, context, options)`
  helper in `framework/execution/` that both kinds call. The chaos
  version passes a per-tick `injectChaos` callback (returning `'success'
  | 'failure' | 'chaos-event'` plus the optional `ChaosEvent`). This is
  the canonical Template Method shape: fixed skeleton, varying step.
  Either inline the helper (preferred for now, given how thin the loops
  are) or migrate both kinds to use the existing `runSimulationLoop`
  with a kind-specific `executeAction` strategy. Don't promote this
  into a class hierarchy — the current closure-based factories are
  fine.

### Two parallel `getMetricValue` implementations

- **Files / code:** `packages/simulation/engine/src/framework/execution/execution-engine.ts:166-206` (`getMetricValue`); `packages/simulation/engine/src/framework/result-builder.ts:28-41,182-216` (`METRIC_FIELD_MAP` + `getMetricValue`).
- **Pattern / principle:** Single Source of Truth; DRY.
- **Status:** Two metric-key resolvers exist with overlapping but not
  identical handling. `execution-engine.ts:getMetricValue` knows
  `recovery_rate`, `p50_latency` (with and without `_ms`), but treats
  `success_rate` as `1` when `totalRequests === 0`. `result-builder.ts`
  uses a `METRIC_FIELD_MAP`, knows `requests_per_second` (which
  execution-engine's version doesn't), and treats `success_rate` as `0`
  on no requests. Either could legitimately be the canonical
  implementation; today it's a coin flip which path runs depending on
  whether assertions are evaluated via `validateAssertions` or via the
  builder.
- **Why it matters:** If a chaos scenario asserts `recovery_rate`, the
  result-builder path returns 0 (no entry in `METRIC_FIELD_MAP`,
  `default: 0`) while the execution-engine path returns the correct
  value. Authors writing assertions across kinds get inconsistent
  semantics.
- **Recommendation:** Extract a single `resolveMetric(metric, metrics,
  durationSeconds?)` function (in `framework/`) and use it from both
  call sites. Reconcile the divergent edge cases (the
  `success_rate`-on-empty disagreement is the only material one).
  Document the supported metric keys in one place.

### Per-kind `validateXxxScenarioConfig` boilerplate

- **Files / code:** `packages/simulation/engine/src/kinds/load/define.ts:61-179`; `packages/simulation/engine/src/kinds/chaos/define.ts:67-173`; `packages/simulation/engine/src/kinds/invariant/define.ts:54-121`; `packages/simulation/engine/src/kinds/fix-evaluation/define.ts:110-278`.
- **Pattern / principle:** Template Method (or shared validation helpers).
- **Status:** Each kind reinvents the same validation skeleton:
  collect-errors-into-array, format with bullet list, throw
  `CoreValidationError` with `code: 'VALIDATION.SCENARIO.INVALID_CONFIG'`
  and `metadata: { errors, kind: '<kind>' }`. The id-pattern check
  (`/^[a-z0-9-]+$/`), name/description nonempty checks, and duplicate-id
  check against `scenarioRegistry` are repeated verbatim across all
  four kinds (with minor variations: load splits id-required from
  id-pattern; chaos combines them).
- **Why it matters:** A new kind currently has to copy this whole
  pattern. The duplicate-name check in `validateDuplicates` runs the
  same `scenarioRegistry.has(config.name)` logic four times; a fix to
  the duplicate-detection semantics needs four edits.
- **Recommendation:** Add a shared `framework/validation.ts` exporting
  `validateScenarioMetadata(config, errors)` (id pattern, name,
  description, tag list), `validateScenarioUniqueness(config, errors)`,
  and `throwValidationErrors(errors, kind)`. Each kind calls these,
  then runs its own kind-specific checks. This keeps the per-kind
  validators focused on what's actually different (chaos's recovery
  window, fix-evaluation's predicate tree, invariant's
  `relatesToInvariant` anchor) and removes ~30 lines of duplication
  per kind. Don't introduce a class hierarchy — composition of free
  functions is the right shape here.

### Misleading "dispatcher switch" diagram in execution-model docs

- **Files / code:** `docs/architecture/30-the-sim-loop/02-execution-model.md:36-55` (lifecycle ASCII art); actual dispatch path: `packages/simulation/engine/src/recipes/service.ts:147-180` (`runSingle`).
- **Pattern / principle:** Documentation/source-of-truth alignment;
  Strategy via polymorphism.
- **Status:** The execution-model doc shows a `dispatcher.execute(scenario,
  ctx) { switch (scenario.kind) ... }` as the central dispatch site.
  No such switch exists. The runtime path is `await scenario.run(signal)`
  — virtual-method dispatch via the `RunnableScenario.run` closure each
  factory (`createLoadScenarioRunner`, `createChaosScenarioRunner`,
  etc.) creates. The exhaustive `switch (result.kind)` exists in
  `result-renderers.ts` (post-run projection), not at dispatch.
- **Why it matters:** A reader looking for "where do I add a new kind?"
  will hunt for a switch that isn't there. The actual extension point
  is the `kind` literal in the factory plus exports from `index.ts`
  plus a new `case` in `renderScenarioResultView` and persistence
  renderers. Misleading docs are a real refactoring tax — the next
  contributor will think the architecture has more central dispatch
  than it actually does.
- **Recommendation:** Update the diagram to show
  `await scenario.run(ctx) /* polymorphic */` and call out the two
  exhaustiveness points: `renderScenarioResultView` and the discriminated
  union narrowing in persistence/dashboard code. Keep the `case` lines
  as guidance, but mark them as "extension point" rather than "runtime
  dispatch."

### `_exhaustive: never` exists at one site only

- **Files / code:** `packages/simulation/engine/src/framework/result-renderers.ts:39-112`; the only kind-discriminated dispatch in the package.
- **Pattern / principle:** Exhaustiveness checking; Strategy.
- **Status:** Only one dispatch site uses the `_exhaustive: never`
  pattern. Every other kind-specific behavior is buried inside the
  per-kind factory closures. That's actually correct — the
  polymorphism removes the need for switches — but it means the
  promise of "adding a new kind is a compile-time exhaustiveness break
  in every dispatch site" (per `scenario-executor-result.ts:11`)
  understates the burden: most of the work is in the new factory
  itself, the exports, the docs, and the recipe-selector enum
  (`packages/simulation/engine/src/recipes/types.ts:36`, hardcoded as
  a string-literal union, not derived from `ScenarioKind`).
- **Why it matters:** The recipe `KindScenarioSelector` and
  `cli/sim.ts:VALID_KINDS` (`Set(['load', 'chaos', ...])`) are both
  open-coded duplicates of `SCENARIO_KINDS`. Adding a new kind
  silently leaves them stale unless the author thinks to update them;
  there is no compile-time enforcement.
- **Recommendation:** Define `KindScenarioSelector.kinds: readonly
  ScenarioKind[]` directly (don't repeat the literal union). Define
  `VALID_KINDS = new Set<ScenarioKind>(SCENARIO_KINDS)`. Then the only
  things to update on a new kind are: new directory under `kinds/`,
  new export from `index.ts`, new union arm in
  `ScenarioExecutorResult`, new case in `renderScenarioResultView`.
  Each of these (except the directory) is compile-time-enforced.

### Invariant kind: throw-NOT-IMPLEMENTED stubs are well-shaped Strategy

- **Files / code:** `packages/simulation/engine/src/kinds/invariant/context.ts:143-156` (`InvariantContextDeps`); `packages/simulation/engine/src/kinds/invariant/executor.ts:39-68` (default deps); `packages/simulation/engine/src/kinds/invariant/define.ts:40-46` (`config.deps?: Partial<InvariantContextDeps>`).
- **Pattern / principle:** Strategy + Null Object (with throwing
  default).
- **Status:** Correct. `InvariantContextDeps` is a typed strategy
  interface; `defaultDeps` are throw-NOT-IMPLEMENTED stubs (a Null
  Object that surfaces unconfigured drivers loudly); test scenarios
  override via `Partial<InvariantContextDeps>` merged into the default.
  The error message even points the author at the override hook
  (`Pass deps.${primitive} to defineInvariantScenario for a test-time
  fake`). The context wrapper (`buildContext`) layers the
  assertion-recording behavior on top of each driver call uniformly.
- **Why it matters:** This is the right pattern for evolving the
  framework before the harness is wired (per Phase 7). Authors can
  write scenarios today against the type-locked interface; a real
  driver swap-in is a single `deps:` parameter at definition time.
- **Recommendation:** None. There's a small opportunity to factor the
  `record(...)` closure pattern (called from every `expectXxx` method)
  into a tiny helper, but it's not load-bearing. Keep an eye on the
  `(actual, expected) => JSON.stringify(actual) === JSON.stringify(expected)`
  in `assertEquals` — that's a known-leaky deep-equality (order-sensitive,
  no Map/Set support) but adequate for current scope; flag it before
  Phase 7 actually wires real scenarios.

### Predicate registry: well-shaped Strategy with one ergonomic gap

- **Files / code:** `packages/simulation/engine/src/kinds/fix-evaluation/predicates/index.ts`.
- **Pattern / principle:** Strategy + Registry.
- **Status:** Correct shape. `PredicateEvaluator` is the Strategy
  interface, `registry` is a `Map<string, PredicateEvaluator>` keyed by
  stable id, framework-shipped stubs throw with a clear migration
  message, `registerPredicate` allows runtime override at composition
  time, and `validatePredicateTree` in `define.ts` fast-fails on
  unknown ids — a typo in the corpus can't silently bypass a
  gaming-defense check.
- **Why it matters:** The `resetPredicateRegistryToBaseline()` helper
  is needed because the registry is a module-level mutable singleton
  (single `const registry = new Map(...)`). Tests must reset between
  runs. There is no mechanism to scope predicates to a single scenario
  composition, so two scenarios in the same process can't disagree
  about what `tests-pass` means.
- **Recommendation:** Document the singleton-scoping decision
  explicitly (probably "intentionally global because predicate
  semantics are conceptually one-per-id"). If multi-scope ever becomes
  needed, the migration is small: pass an optional
  `predicateRegistry: ReadonlyMap<string, PredicateEvaluator>` into
  `createFixEvaluationScenarioRunner`. The `predicateRegistry` re-export
  (line 87) types the public surface as `ReadonlyMap`, but the underlying
  `registry.set` calls in `registerPredicate` still mutate it — fine for
  the singleton model, but worth a comment.

### Chaos kind composes load via copy, not Strategy

- **Files / code:** `packages/simulation/engine/src/kinds/chaos/executor.ts:36-102` (`runWindow`); `packages/simulation/engine/src/kinds/chaos/define.ts:32-59` (`ChaosScenarioConfig`).
- **Pattern / principle:** Composition over Inheritance; Decorator.
- **Status:** Documented as "composes load with chaos injection" but
  the actual code copies the load loop body and inlines a chaos branch
  (see Finding 1). The chaos config also re-declares the load fields
  (`personas`, `duration`, `rampUp`, `targetRps`) inline rather than
  embedding a `LoadScenarioConfig` fragment. Compare to the
  documentation in `01-scenarios-and-recipes.md:84` which shows
  `baseLoad: { /* a LoadScenarioConfig fragment */ }` — the actual
  implementation flattens this.
- **Why it matters:** The promise of chaos-as-decorator is that a
  chaos scenario's load behavior is a literal reference to a
  `LoadScenarioConfig`; today it's a copy of those fields. If load
  grows a new field (say `coolDown`), chaos won't pick it up
  automatically.
- **Recommendation:** Decide which model is canonical. Either:
  (a) implement the doc's `baseLoad: LoadScenarioConfig`-fragment
  shape (proper composition; chaos's recovery window + chaos config
  decorate a load definition); or
  (b) update the doc to show the flattened shape that's actually in
  the code. Option (a) is the right architectural call but it's a
  breaking change to the chaos config shape, so option (b) is
  acceptable as a near-term fix.

### `simulation/recipes` and `fitness/recipes` share intent but not code

- **Files / code:** `packages/simulation/engine/src/recipes/{types.ts,registry.ts,define-recipe.ts,built-in-recipes.ts,service.ts}` (~500 LOC); `packages/fitness/engine/src/recipes/*.ts` (~1900 LOC).
- **Pattern / principle:** DRY; abstraction at the right layer.
- **Status:** Real overlap on the small surface; intentional divergence
  on the large surface. Both registries (`SimulationRecipeRegistry`,
  `FitnessRecipeRegistry`) have nearly identical
  `byId`/`byName`/`register`/`has`/`getAll`/`clear`/`reset`/`listForDisplay`
  implementations. Both `defineXxxRecipe` factories validate
  id/name/scenarios-or-checks/execution. Both use selector unions
  (`all`/`tags`/`explicit` plus one tool-specific selector — `pattern`
  for fit, `kind` for sim). The `BUILT_IN_NAMES` Set pattern is
  duplicated. The fitness service is much heavier (file cache, parse
  cache, parallel scheduler, retry, callbacks); sim's is intentionally
  ~70 lines.
- **Why it matters:** The trivial duplication (registry plumbing,
  `id`/`name`/`displayName`/`description`/`tags` shape, the Built-In
  Set, the URCP_/RCP_/BSCP_ id-prefix conventions) is genuinely shared.
  The non-trivial pieces (selector resolution, execution
  orchestration) are not — fit needs file-set resolution, sim doesn't.
  Today, a change to the registry semantics (e.g. how name collisions
  are detected; how display info is computed) requires two near-identical
  edits.
- **Recommendation:** Promote `RecipeRegistry<T>` (and the `BUILT_IN_NAMES`
  pattern) into either `@opensip-tools/contracts` or
  `@opensip-tools/core`. The signature would be
  `RecipeRegistry<T extends { id: string; name: string;
  displayName: string; description: string; tags?: readonly string[] }>`.
  Both packages would then construct
  `new RecipeRegistry<FitnessRecipe>(builtInRecipes)` or
  `new RecipeRegistry<SimulationRecipe>(builtInSimulationRecipes)`.
  Do NOT extract the recipe service or the selector resolver — those
  legitimately diverge. This is consistent with the existing
  `GenericRegistry<T>` in `framework/generic-registry.ts` (which is
  itself a copy of the core registry; see the file comment).

### `Signal.source = 'simulation'` claim — accurate

- **Files / code:** `packages/simulation/engine/src/framework/execution/execution-engine.ts:415-434` (`emitSimulationSignal`); `packages/simulation/engine/src/framework/execution/action-handlers.ts:140-160,167-187,217-235,252-271` (chaos/error/timeout/exception signal emission); `packages/simulation/engine/src/kinds/fix-evaluation/define.ts:77-84` (the `source` literal union).
- **Pattern / principle:** Source-of-truth/contract integrity.
- **Status:** Accurate. Every signal-creation call inside the
  simulation runtime path passes `source: 'simulation'`. The
  `FixEvaluationScenarioConfig.source` field includes `'simulation'`
  but also `'fitness'` and others — that's intentional, because a
  fix-evaluation scenario's *replayed* signal can have come from any
  upstream source; the field documents the original signal's source,
  not who synthesized it.
- **Why it matters:** Persistence/dashboard filters on `source` work
  correctly today.
- **Recommendation:** None. Document the dual meaning in the
  fix-evaluation `source` field's comment (the current comment leaves
  it ambiguous). Add a test that asserts `source === 'simulation'` for
  signals emitted by the load/chaos action handlers, to prevent
  regression if the literal becomes a config option later.

### Primitive obsession in `ScenarioAssertion.metric: string`

- **Files / code:** `packages/simulation/engine/src/types/base-types.ts:79-84` (`ScenarioAssertion`); `packages/simulation/engine/src/framework/execution/execution-engine.ts:166-206` and `packages/simulation/engine/src/framework/result-builder.ts:28-41,182-216` (metric resolution).
- **Pattern / principle:** Replace Magic String with Constant /
  Replace Primitive with Object.
- **Status:** Real primitive obsession. `metric: string` accepts any
  string; resolution returns `0` for unknown keys (not an error).
  Authors can write `assertion.metric = 'p99-latnecy'` (typo) and the
  scenario will pass with the metric silently treated as 0.
- **Why it matters:** Combined with Finding 2 (two divergent metric
  resolvers), the typing is doubly weak: even known keys can resolve
  to different values depending on which path runs.
- **Recommendation:** Define a string-literal union
  `type ScenarioMetricKey = 'error_rate' | 'success_rate' | ...` (the
  intersection of the keys both resolvers handle). Type
  `ScenarioAssertion.metric: ScenarioMetricKey`. Authors get
  autocomplete and typo-detection. The shared `resolveMetric` from
  Finding 2 then becomes a typed function — no `default: return 0`
  silent-failure path.

### `RunnableScenario.tags` is `readonly string[]`, never typed

- **Files / code:** `packages/simulation/engine/src/framework/runnable-scenario.ts:25`; tag-based filtering in `framework/registry.ts:32-34` and `recipes/service.ts:124-131`.
- **Pattern / principle:** Type-driven discoverability.
- **Status:** Tags are bare strings. The `--kind` filter is properly
  typed via `KindScenarioSelector.kinds`, but tag selectors are
  open-string both at recipe-author time and at scenario-author time.
- **Why it matters:** Recipes referencing tags by string have no
  cross-check against scenario tags; a typo in the recipe silently
  selects nothing. Less critical than the metric-string finding
  because the resolution is "select empty" rather than "evaluate as 0",
  but it's the same shape.
- **Recommendation:** Probably don't fix this yet — tags are
  intentionally an open vocabulary. Document the contract that recipe
  authors are responsible for tag/scenario alignment, and consider a
  startup-time warning: "recipe `pre-deploy` references tag
  `database-chaos` but no registered scenario has that tag."

### `defineScenarioWithoutRegistration` family — bare-minimum validation drift

- **Files / code:** `packages/simulation/engine/src/kinds/load/define.ts:216-235`; `packages/simulation/engine/src/kinds/chaos/define.ts:192-203`; `packages/simulation/engine/src/kinds/invariant/define.ts:140-151`; `packages/simulation/engine/src/kinds/fix-evaluation/define.ts:299-313`.
- **Pattern / principle:** Don't Repeat Yourself; consistency.
- **Status:** Each kind ships a `defineXxxScenarioWithoutRegistration`
  test helper that validates only `id` (chaos/invariant/fix-evaluation)
  or `id` + a manual error-array build (load). The omission is
  deliberate — tests need to construct lots of scenarios without
  touching the registry — but the API surface diverges: load includes
  the standard error-array boilerplate, chaos throws a single message
  from the constructor, invariant throws inline, fix-evaluation throws
  inline. None go through the same shared validation as the public
  `defineXxxScenario`.
- **Why it matters:** Test scenarios skip duplicate-id-against-registry
  and most field validation. That's fine for the test-only intent, but
  it means tests can construct scenarios that the production
  `defineXxxScenario` would reject — masking validation regressions.
  The four implementations also differ stylistically.
- **Recommendation:** Either (a) make `defineXxxScenarioWithoutRegistration`
  call the same validator with a flag (`{ skipRegistryCheck: true }`)
  so test scenarios go through the same gate as production, or
  (b) document the deliberate divergence and unify the four
  implementations on a shared helper that throws on missing id and
  nothing else. Option (a) catches more bugs; option (b) is cheaper.

## Non-findings considered and dismissed

- **"Polymorphic dispatch via virtual `run()` should be replaced with
  a central switch."** No — virtual dispatch is the better choice
  here. The `RunnableScenario` factories already encapsulate per-kind
  state in closures; centralizing dispatch would force a function
  registry and hand back type-erased configs. The current design is
  the textbook Replace-Conditional-with-Polymorphism shape.

- **"`SCENARIO_KINDS` and the discriminator union should be derived
  from a single source."** Considered, but the current
  `type ScenarioKind = ... | ...` + `const SCENARIO_KINDS = [...]` +
  the `kind: 'load'` / `kind: 'chaos'` literals in factory methods all
  reference the same string set, and TypeScript will error at compile
  time if they drift (because `kind: 'lod' as const` doesn't satisfy
  `RunnableScenario.kind: ScenarioKind`). The remaining duplications
  (recipes/types.ts, cli/sim.ts) are real and called out in Finding 4.

- **"`ScenarioExecutionContext` and `ExecutorContext` are
  near-duplicates and should be unified."** Looked. They overlap
  (`abortSignal`, `correlationId`, `logger`) but `ExecutorContext`
  also carries `runId`, `recipeId`, `checkAborted`, and a richer
  logger with structured-entry methods. The new kind factories use
  `ScenarioExecutionContext`; only the legacy `createScenario` /
  `createStandardExecutor` use `ExecutorContext`. As the legacy paths
  retire, `ExecutorContext` and `ScenarioExecutor` can be deleted.
  Until then, both are needed.

- **"`createScenario`/`createStandardExecutor` are dead code."** Not
  yet — they're exported from the barrel (`index.ts`) and still
  referenced by `framework-types.ts` (`CustomExecuteFn`). The legacy
  alias path uses them indirectly. Once `defineScenario` is removed
  (one release), they can come out.

- **"The recipe `BSCP_default` id-prefix is undocumented magic."**
  It's a stable string literal used by `listForDisplay` and tests; if
  more built-in recipes ship, the convention scales fine. The
  `URCP_`/`RCP_`/`BSCP_` family of prefixes is implicitly contracted
  (URCP_ = user, RCP_ = built-in fitness, BSCP_ = built-in sim) but
  not documented in one place. Worth a short README note in
  `recipes/`, but not a structural finding.

- **"`emitSimulationSignal` and the inline `createSignal` calls in
  `action-handlers.ts` should share a builder."** Looked.
  `emitSimulationSignal` is the proper builder for ad-hoc emission;
  the inline calls in chaos/error/timeout/exception handlers each
  shape a fixed `ruleId`/`severity`/`category`/`message` per case.
  These are five distinct fixed-shape signals, not a builder
  candidate. The data is short enough that a builder would obscure
  the per-case intent.
