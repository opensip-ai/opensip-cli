# Architecture audit — simulation

**Date:** 2026-05-27
**Scope:** packages/simulation/engine
**Auditor:** Claude

## Summary

The simulation namespace is a well-layered tool-plugin that mostly does the right things: a single discriminated union over scenario kinds (`ScenarioExecutorResult`), an exhaustive renderer with a `never` guard, Template Method for the load/chaos windowed loop, shared validation helpers, and a clean Tool contract surface. The four kind-specific `defineX` entry points are coherent — same structural recipe (validate → build runner → register), same `RunnableScenario` contract, same testability twin (`...WithoutRegistration`). The Strategy split across `kinds/<kind>/executor.ts` is correct.

The cracks are around side-effect registration, module-level mutable state, and a handful of structural inconsistencies that will get worse as kinds are added:

1. **Side-effect registration leaks across the public API.** `defineX` mutates a singleton at module-import time; this is the documented design but couples every consumer (tests, programmatic use, multi-project hosts) to whichever scenarios were imported by anyone in the process. There is no per-host scope.
2. **Two coupled-but-separate caches of "already loaded" state** in `cli/sim.ts` produce a subtle bug class around hook re-installation and concurrent load.
3. **`SimulationRecipeRegistry` bypasses its own parent's `register()` contract** by writing to `protected` internals — the OCP fix in the base class never gets applied to built-ins.
4. **Recipe service is a partial Strategy** — execution-mode dispatch is an inline switch that will not scale to a third mode without copying the dispatch into every call site.
5. **Validation collectors are duplicated** across kinds: each `define.ts` repeats the assemble-errors-and-throw skeleton with only the kind-specific block differing — a clear missing Template Method.
6. **Scenarios with custom `execute` have a divergent factory shape** (two factories with near-identical envelopes) where a single Builder/Adapter would clarify intent.

None of these are emergencies, but they are the architectural pressure points where adding a fifth kind (or a SaaS-mode host that needs scenario isolation) will hurt. Specific recommendations below.

## Findings

### F1 — Module-level singleton registry plus side-effect `defineX` registration leak across the public API

- **Files:**
  - `packages/simulation/engine/src/framework/registry.ts:15` (`scenarioRegistry` singleton)
  - `packages/simulation/engine/src/kinds/load/define.ts:174`
  - `packages/simulation/engine/src/kinds/chaos/define.ts:162`
  - `packages/simulation/engine/src/kinds/invariant/define.ts:113`
  - `packages/simulation/engine/src/kinds/fix-evaluation/define.ts:266`
  - `packages/simulation/engine/src/plugins/types.ts` (entire file documents the leak)
- **Principle/Pattern:** Singleton + side-effect Builder; SRP / DIP.
- **Status:** Problematic (intentional design, but the architectural cost is high enough to call out).
- **Evidence:** Every `defineX` is shaped as:
  ```ts
  validateXScenarioConfig(config);
  const scenario = createXScenarioRunner(config);
  scenarioRegistry.register(scenario); // ← side effect on module-global state
  return scenario;
  ```
  And the plugin loader explicitly relies on it (`packages/simulation/engine/src/plugins/loader.ts:18-31`, `packages/simulation/engine/src/cli/sim.ts:154-163`), measuring `scenarioRegistry.size` deltas around `coreLoadPlugin` because the act of importing a scenario file is the registration event.
- **Why it matters:** The current design hard-codes process-wide scenario state into the act of definition. Concrete consequences:
  - Tests have to call `clearScenarioRegistry()` (`framework/registry.ts:43`) or use `...WithoutRegistration` twin functions — every kind has to ship a paired API just so tests can construct scenarios without polluting global state. That's a code smell the twins were built to mask, not solve.
  - The plugin loader has to use snapshot-delta accounting (`plugins/loader.ts:107-130`) — its own header even calls this out as "the price of the side-effect registration design we picked."
  - A future SaaS-mode host that wants to load Tenant A's scenarios and Tenant B's scenarios in the same process cannot do so; they share `scenarioRegistry`.
  - `defineSimulationRecipe` (`recipes/define-recipe.ts:49`) does the same thing for recipes, which the file header explicitly admits is a "tests call .clear() in afterEach" workaround.
- **Recommendation:** Make registration explicit, not implicit. Two viable shapes:
  - **Option A (least churn):** `defineX` returns a `RunnableScenario` *without* side effects; introduce a single `registerScenarios(...scenarios: RunnableScenario[])` that the plugin loader and authoring sites call explicitly. The `...WithoutRegistration` twins disappear. Tests get isolation for free.
  - **Option B (deeper, SaaS-ready):** Make `scenarioRegistry` a per-host instance threaded through a `SimulationHost` object. `defineX` is registry-free; `host.register(scenario)` is the registration boundary. The CLI bootstraps one host per project.
  Either way, the `defineX` API stops being a registration side-effect carrier and becomes a pure factory. The plugin loader's `sizeBefore`/`sizeAfter` accounting becomes the loader returning the imported module's exports directly. The plugin-types contract becomes honest about what it expects.

### F2 — `SimulationRecipeRegistry.registerBuiltInRecipes()` bypasses its parent's public contract

- **Files:**
  - `packages/simulation/engine/src/recipes/registry.ts:32-39`
  - `packages/core/src/recipes/registry.ts:74-75` (the `protected` fields the subclass writes to)
- **Principle/Pattern:** Liskov Substitution; Open/Closed; encapsulation of inherited state.
- **Status:** Problematic.
- **Evidence:**
  ```ts
  private registerBuiltInRecipes(): void {
    // Built-in recipes ship valid; bypass the duplicate guard via direct
    // map writes to preserve registration order semantics.
    for (const recipe of builtInSimulationRecipes) {
      this.byId.set(recipe.id, recipe);
      this.byName.set(recipe.name, recipe);
    }
  }
  ```
  The subclass reaches into the parent's `protected` `byId`/`byName` Maps and bypasses every invariant the parent's `register()` enforces (duplicate detection, byId/byName cross-consistency cleanup at `core/src/recipes/registry.ts:128-134`).
- **Why it matters:** The base class's whole job is to keep `byId` and `byName` consistent across overwrites. If a future version of core adds (say) an event hook, a validation pass, or a "registered-at" timestamp inside `register()`, built-ins will silently skip it. The comment says "preserve registration order" — but the public `register({ allowOverwrite: true, throwOnDuplicate: false })` already preserves order in insertion-time terms. The bypass exists to dodge the duplicate guard, not to preserve ordering.
- **Recommendation:** Have core's `RecipeRegistry` expose a `protected registerInternal(recipe, { skipDuplicateCheck: true })` (or equivalent named-method) that the subclass calls. The subclass stops touching `byId`/`byName` directly and the base class regains ownership of its invariants. Alternative: pass built-ins to the parent constructor and let `RecipeRegistry` own the "ships-with-built-ins" concept directly (it'd serve fitness too).

### F3 — Two coupled-but-separate caches of "already loaded" state with subtle race semantics

- **Files:**
  - `packages/simulation/engine/src/cli/sim.ts:59` (`scenariosLoadedFor`)
  - `packages/simulation/engine/src/cli/sim.ts:62` (`pluginLoadErrors`)
  - `packages/simulation/engine/src/cli/sim.ts:84` (`preLoadHook`)
  - `packages/simulation/engine/src/cli/sim.ts:96-150` (`ensureScenariosLoaded`)
- **Principle/Pattern:** SRP; encapsulation of lifecycle state; tell-don't-ask.
- **Status:** Problematic.
- **Evidence:** `ensureScenariosLoaded` reads/writes three module-level mutables (`scenariosLoadedFor`, `pluginLoadErrors`, and implicitly the global `scenarioRegistry`) without any guard against concurrent invocation. The "loaded" sentinel is a single string; a concurrent second call against a different `projectDir` while the first is mid-load will see `scenariosLoadedFor !== key` and start a parallel load that registers into the same shared `scenarioRegistry`. `setPreLoadHook` mutates `preLoadHook` at any time, including after the first `ensureScenariosLoaded`, in which case the hook is silently skipped on subsequent calls because they short-circuit on the `scenariosLoadedFor === key` check.
- **Why it matters:** This is fragile in three ways:
  1. **Hook-installation ordering bug** — if `setPreLoadHook` is called *after* the first `ensureScenariosLoaded` (e.g. a test installs a hook after running sim once), it never fires; the test fails for opaque reasons.
  2. **No reentrancy guard** — `ensureScenariosLoaded(a)` and `ensureScenariosLoaded(b)` interleaved on the same event loop will both pass the cache check and both call `loadAllSimPlugins`.
  3. **`pluginLoadErrors` is global** — `getPluginLoadErrors()` always returns the *last* call's errors, hiding errors from any earlier project dir.
- **Recommendation:** Encapsulate this in a `ScenarioLoader` class with a single private `Promise<void>` per projectDir (so concurrent calls await the in-flight load), a constructor-injected `preLoadHook`, and per-load errors returned by the load itself rather than parked in a module global. The free function shape stays for back-compat, but it delegates to the class. This also makes F1 easier — a `ScenarioLoader` is the natural home for a non-global registry.

### F4 — `SimulationRecipeService` execution-mode dispatch is an inline conditional, not Strategy

- **Files:**
  - `packages/simulation/engine/src/recipes/service.ts:73-75` (mode dispatch)
  - `packages/simulation/engine/src/recipes/service.ts:185-209` (`runSequential` / `runParallel`)
- **Principle/Pattern:** Strategy; OCP.
- **Status:** Problematic (small surface today, but it's the wrong shape for what already exists).
- **Evidence:**
  ```ts
  const results = recipe.execution.mode === 'parallel'
    ? await runParallel(matched, recipe, this.config.abortSignal)
    : await runSequential(matched, recipe, this.config.abortSignal);
  ```
  And the signatures already diverge: `runParallel` doesn't actually consult the recipe (`_recipe`), `runSequential` does (for `stopOnFirstFailure`).
- **Why it matters:** `SimulationExecutionOptions.mode` is typed as `'parallel' | 'sequential'` (`recipes/types.ts:55`); adding "bounded-parallel" with `maxParallel` (already in the options type at `recipes/types.ts:57` but unused) requires another branch and another helper. `stopOnFirstFailure` already only works for the sequential path because the dispatch lost type-level structure. The Strategy pattern fits: a small `ExecutionStrategy` interface with one method (`run(scenarios, recipe, signal) -> SimulationScenarioResult[]`) and a registry/map keyed by mode. Adding `bounded` is one new class.
- **Recommendation:** Extract `interface ExecutionStrategy` and three implementations (`SequentialStrategy`, `ParallelStrategy`, future `BoundedParallelStrategy`). Replace the ternary with a strategy-table lookup. Push `stopOnFirstFailure` into the strategy's contract so the parallel strategy makes an explicit "this is best-effort" decision instead of silently ignoring it.

### F5 — Per-kind `validateXScenarioConfig` repeats the same wrapper skeleton — missing Template Method

- **Files:**
  - `packages/simulation/engine/src/kinds/load/define.ts:123-147`
  - `packages/simulation/engine/src/kinds/chaos/define.ts:138-152`
  - `packages/simulation/engine/src/kinds/invariant/define.ts:91-103`
  - `packages/simulation/engine/src/kinds/fix-evaluation/define.ts:239-254`
- **Principle/Pattern:** Template Method / DRY.
- **Status:** Problematic.
- **Evidence:** Every validator follows the same five-step pattern:
  ```ts
  const errors: ScenarioValidationError[] = []
  validateScenarioMetadata(config, errors)
  /* kind-specific checks */
  validateScenarioUniqueness(config, errors, {
    ...(options.skipRegistryCheck === undefined ? {} : { skipRegistryCheck: options.skipRegistryCheck }),
  })
  throwValidationErrors(errors, '<kind>')
  ```
  Only the kind-specific helper calls differ. The spread-merge of `skipRegistryCheck` is even copy-pasted character-for-character across the four files.
- **Why it matters:** Adding a new kind requires copying this skeleton; a future cross-cutting validation step (e.g. "every scenario must declare an owner") has to be added in four places, and is silently skipped if you forget one. It also makes it harder to add per-kind validation customization in a structured way.
- **Recommendation:** Introduce `validateScenarioConfig<C>(config: C, kind: ScenarioKind, validateKindSpecific: (config: C, errors: ScenarioValidationError[]) => void, options?: { skipRegistryCheck?: boolean })` in `framework/validation.ts`. Each `define.ts` becomes a one-liner around it. The skip-flag plumbing collapses to a single call site.

### F6 — Load-kind has two parallel factory functions (`createStandardExecutor` / `createCustomExecutor`); should be one path with an adapter

- **Files:**
  - `packages/simulation/engine/src/kinds/load/executor.ts:34-67` (standard)
  - `packages/simulation/engine/src/kinds/load/executor.ts:76-101` (custom)
  - `packages/simulation/engine/src/kinds/load/executor.ts:112` (selector)
- **Principle/Pattern:** Strategy/Adapter; DRY.
- **Status:** Problematic.
- **Evidence:** The two factories share ~80% of their body (build the envelope, freeze, attach `kind: 'load'`). They differ only in how they produce the inner payload — `runLoadWindow + ScenarioResultBuilder` versus `customFn(context)`.
- **Why it matters:** The "custom executor" path is a back-door around `runLoadWindow`. If `runLoadWindow` gains a new feature (richer events, request-trace propagation, additional metrics field), the custom path silently won't have it because it manufactures its own payload. The current design also means there's no place to enforce that custom executors honor the abort signal — they could return synchronously and starve the loop.
- **Recommendation:** One executor factory; the variation point is the `producePayload(context): Promise<LegacyLoadResultPayload>` function — default is "use `runLoadWindow` + `ScenarioResultBuilder`", custom is "delegate to `config.execute`". The envelope-build, freeze, and timing wrapping happens once. Better: phase out `CustomExecuteFn` (the type is already legacy per `types/framework-types.ts:79-105`) once chaos/invariant/fix-evaluation never offered it and load can be the same way. Chaos already documents this design choice at `kinds/chaos/define.ts:37-40` ("A custom-`execute` escape hatch would undermine the injection model and is intentionally omitted here") — that argument applies to load too.

### F7 — `ScenarioResultBuilder.build()` returns a deprecated type — the entire builder is legacy load-shaped, not kind-aware

- **Files:**
  - `packages/simulation/engine/src/framework/result-builder.ts:141` (returns `LegacyLoadResultPayload`)
  - `packages/simulation/engine/src/types/framework-types.ts:79-96` (`@deprecated LegacyLoadResultPayload`)
  - `packages/simulation/engine/src/kinds/chaos/executor.ts:62-71` (chaos uses the load-shaped builder for chaos verdicts)
- **Principle/Pattern:** Single Responsibility / Interface Segregation.
- **Status:** Problematic.
- **Evidence:** The Builder is named "ScenarioResultBuilder" but its public surface only knows load shape — metrics + assertions + signals. Chaos's `evaluateAssertionsForWindow` (`kinds/chaos/executor.ts:57-72`) routes through the load builder just to get its `evaluateAssertions(...)` step, then throws away most of the result and keeps only `assertions.passed`/`assertions.failed`. Invariant and fix-evaluation kinds don't use it at all.
- **Why it matters:** The Builder pretends to be a cross-kind abstraction (its name) but is actually a load-shape implementation detail. Other kinds either re-implement its logic or contort through it. Adding a fifth kind makes the misnomer worse. The `@deprecated LegacyLoadResultPayload` annotation already signals the framework knows this is wrong; nothing has been done to retire it.
- **Recommendation:** Two paths:
  - **Either** rename the class to `LoadResultBuilder`, keep it in `kinds/load/` (it doesn't belong in framework/ if it only produces load shape), and let each future kind own its own builder if it wants one.
  - **Or** split the responsibilities: extract a small `AssertionEvaluator` helper that takes metrics + assertions and returns `{passed: ScenarioAssertion[], failed: FailedAssertion[]}` — this is what chaos actually wants. Load's Builder then wraps it for the full load envelope. The deprecated `LegacyLoadResultPayload` is gone in either case.

### F8 — `SimPluginExports` interface omits `scenarios` by design, but the loader still has to special-case scenario counts

- **Files:**
  - `packages/simulation/engine/src/plugins/types.ts:21-23` (interface)
  - `packages/simulation/engine/src/plugins/loader.ts:108-133` (snapshot-delta accounting)
- **Principle/Pattern:** Interface Segregation / honest interfaces.
- **Status:** Problematic.
- **Evidence:** `SimPluginExports` is a single-field interface (`recipes?`), with a long file-level comment explaining that scenarios are *intentionally* missing because they self-register. The loader then has to re-implement core's `loadAllPlugins` outer loop just so it can snapshot `scenarioRegistry.size` around each plugin import (`plugins/loader.ts:112-130`). The loader's comment ("the price of the side-effect registration design we picked") admits this is paying interest on F1's design choice.
- **Why it matters:** The interface lies about the contract. A plugin author reading `SimPluginExports` sees "I just export recipes" and has no way to know their `defineLoadScenario` calls at module top-level are the actual registration mechanism. The lie also makes the loader more complex than fitness's equivalent: fitness's `loadAllPlugins('fit', ...)` is a single call; sim's `loadAllSimPlugins` is a manual outer loop.
- **Recommendation:** Tied to F1's resolution. Once `defineX` is side-effect-free, `SimPluginExports` becomes:
  ```ts
  interface SimPluginExports {
    readonly scenarios?: readonly RunnableScenario[];
    readonly recipes?: readonly SimulationRecipe[];
  }
  ```
  The loader becomes one call to core's `loadAllPlugins`; the snapshot-delta math disappears. Scenario packages that don't want to maintain an `scenarios` array can use a barrel helper (`collectScenarios()`) that registers nothing but assembles the list.

### F9 — `discoverScenarioPackages` mixes resolution policy and filesystem walking; ripe for Chain of Responsibility / Strategy

- **Files:**
  - `packages/simulation/engine/src/plugins/scenario-package-discovery.ts:77-112` (resolution rules)
  - `packages/simulation/engine/src/plugins/scenario-package-discovery.ts:123-149` (ancestor walk)
- **Principle/Pattern:** OCP; SRP.
- **Status:** Problematic (small but representative).
- **Evidence:** `discoverScenarioPackages` implements three resolution rules in a single function with two early returns. The "explicit list wins / opt-out / auto-discover" rules are policy; `autoDiscoverScenarios` is mechanism. Adding a fourth rule (e.g. "if `OPENSIP_SCENARIOS` env var is set, use it") requires opening this function.
- **Why it matters:** The combined policy+mechanism makes testing harder (you can't test "explicit list wins" without also touching disk for the explicit-list check at `scenario-package-discovery.ts:88-100`). Sharing the resolution rule set with fitness's `discoverCheckPackages` is impossible because they're inlined here.
- **Recommendation:** Pull the resolution into a small `PackageDiscoveryPolicy` object with strategies: `ExplicitList`, `OptOut`, `AutoDiscover` (Chain of Responsibility). Mechanism (`autoDiscoverScenarios` walking node_modules) is one strategy's `apply()` body. Fitness's check-package discovery can share the same chain.

### F10 — `defineFixEvaluationScenario` validation duplicates the discriminator-leaf walk between `validatePredicateTree` and `validateGamingDefense`

- **Files:**
  - `packages/simulation/engine/src/kinds/fix-evaluation/define.ts:149-190` (tree walk)
  - `packages/simulation/engine/src/kinds/fix-evaluation/define.ts:192-227` (gaming defense)
  - `packages/simulation/engine/src/kinds/fix-evaluation/executor.ts:33-65` (third walk, placeholder verdict)
- **Principle/Pattern:** Visitor / single recursive walker; DRY.
- **Status:** Problematic.
- **Evidence:** Three separate recursive walkers over the predicate tree:
  1. `validatePredicateTree` — collect "unknown predicate id" errors.
  2. `validateGamingDefense` — find any leaf in a fixed set.
  3. `placeholderVerdict` — build a mirror tree of `passed: false` verdicts.
  Each re-implements the "is this a composite or a leaf" detection (`hasAllOf || hasAnyOf`) and the children-array selection. They share casts (`node as PredicateComposition`, `node as PredicateLeaf`) that subtly differ — `placeholderVerdict` checks `typeof leaf.id === 'string'` and falls back to `'unknown'`; the validators reject empty/non-string ids.
- **Why it matters:** Three walks means three places to break in subtly different ways. The cast pattern (`node as PredicateComposition` then "check `all_of`/`any_of`") is a hand-rolled type-narrowing where a discriminator field on the composition vs. leaf would make the union type-safe and the walks share a single visitor.
- **Recommendation:** Refactor `PredicateComposition | PredicateLeaf` to a tagged union (`type PredicateNode = { type: 'composite'; ... } | { type: 'leaf'; ... }`) so the walks become exhaustive switches. Extract one `walkPredicateTree(node, visitor)` that the validators and the placeholder verdict builder share. The "any leaf in a required set" check becomes a one-line predicate in the visitor.

### F11 — `setPreLoadHook` is a singleton mutable global with no instance/scope

- **Files:**
  - `packages/simulation/engine/src/cli/sim.ts:80-89`
  - `packages/simulation/engine/src/tool.ts:108` (re-export)
- **Principle/Pattern:** Dependency Injection.
- **Status:** Problematic.
- **Evidence:** `setPreLoadHook` mutates module-level state. The docstring at `cli/sim.ts:75-79` admits the design assumption — "called once before the first ensureScenariosLoaded()" — but nothing in the code enforces or even checks that invariant. A second `setPreLoadHook(differentHook)` silently replaces; a hook installed after the first load is silently ignored.
- **Why it matters:** This is the simulation tool's only seam for "the CLI wants to do project-plugin auto-sync first." A SaaS-mode host that wants to install a different pre-load hook per request cannot, because there's one slot. The "called once" assumption is a comment, not a contract.
- **Recommendation:** Pass the pre-load hook as a parameter on the loader. Either:
  - `ensureScenariosLoaded(projectDir, { preLoadHook })` — explicit per call.
  - The `ScenarioLoader` class from F3 takes `preLoadHook` in its constructor.
  The `Tool` re-export goes away; the CLI bootstrap composes a `ScenarioLoader` with the hook and passes it down.

### F12 — `runLoadWindow` has a coupling between metrics population and the loop that hides a real bug class

- **Files:**
  - `packages/simulation/engine/src/framework/execution/run-load-window.ts:108-141` (`applyOutcome`)
  - `packages/simulation/engine/src/framework/execution/run-load-window.ts:184-211` (loop)
- **Principle/Pattern:** SRP; Command.
- **Status:** Problematic (correctness adjacent).
- **Evidence:** `applyOutcome` mutates `metrics` in-place and pushes events; the loop additionally increments `metrics.totalRequests` and records latency separately. The "success rate" semantics depend on which mutation order happens — for a `null` (default) outcome the loop's `metrics.totalRequests++` runs *before* `applyOutcome`'s 95% roll, but for a `'success'` outcome from `injectChaos` the order is the same. There's no clear contract that `applyOutcome` doesn't touch `totalRequests`; today it doesn't, but adding a new outcome kind that "doesn't count" (e.g. `'skipped'` for a circuit-breaker test) requires either decrementing `totalRequests` post-hoc or threading more state through.
- **Why it matters:** This is the load/chaos critical path; the two-step mutation model is fragile. A future kind that needs a different counting policy will end up either reimplementing the loop or special-casing here.
- **Recommendation:** Make `applyOutcome` (or a successor) return a `MetricsDelta` (Command pattern — explicit small object: `{ requestsAdded, succeeded, failed, errorsGenerated, event? }`) that the loop applies. The loop owns metric mutation; the outcome-handler is pure. This also makes the dispatch testable without standing up a full window.

## Strengths

- **Discriminated union over kinds (`ScenarioExecutorResult`) with exhaustiveness guard** in `framework/result-renderers.ts:106` — `const _exhaustive: never = result` forces compile-time breakage when a new kind is added. Textbook correct usage.
- **Template Method shape for load/chaos windowed execution** — `runLoadWindow` owns the loop; chaos supplies `injectChaos`. The `TickOutcome<T>` discriminated union is type-parameterized so chaos's events come back typed as `ChaosEvent` without runtime casts (`run-load-window.ts:172-180` plus `chaos/executor.ts:107-120`). This is a clean Strategy/Template Method intersection.
- **Validation shared helpers** (`framework/validation.ts`) — `validateScenarioMetadata`, `validateScenarioUniqueness`, `throwValidationErrors` extract the cross-cutting concerns correctly. F5's recommendation is the next step on the same trajectory.
- **`InvariantContextDeps` driver injection** (`kinds/invariant/context.ts:143-156`) — clean Strategy/DI for the invariant context's drivers. The default deps throw-NOT-IMPLEMENTED stubs are an honest placeholder that test fixtures replace.
- **Predicate registry as Strategy table** (`kinds/fix-evaluation/predicates/index.ts`) — id-keyed evaluator map with a clear `registerPredicate` extension point. Framework-shipped predicates are stubs that throw a clear "wire me up" message; the harness replaces them at composition time. This is exactly the right shape for a pluggable predicate set.
- **Per-scenario `ScenarioLogger` as Adapter** (`framework/scenario-logger.ts`) — wraps the kernel `logger` with stable `evt: simulation.scenario.<level>` tags and a `scenarioId` field. Each scenario gets its own logger; the kernel logger stays generic.
- **Tool contract implementation** (`tool.ts`) — small, declarative, exports a single `simulationTool: Tool`; the CLI dispatcher imports nothing from the engine except this descriptor. The `toolOptsToCliArgs` adapter is explicit and clearly marked as a bridge to legacy `CliArgs`.
- **`ScenarioAbortedError` is a dedicated error class** (`framework/execution/scenario-aborted-error.ts`) — kind executors throw a specific subtype, not a generic `Error('aborted')`. The CLI/recipe service can distinguish "aborted" from "failed."
- **Recipe shape mirrors fitness's** (`recipes/types.ts`, `recipes/define-recipe.ts`) — same `ScenarioSelector` discriminated union pattern fitness uses for check-selectors, same `defineSimulationRecipe` factory shape. Mirroring is consistent enough that the cognitive load for users authoring both is low.
- **`Object.freeze` discipline on results and configs** — every kind's `createXScenarioRunner` returns a frozen `RunnableScenario` whose `run()` returns a frozen `ScenarioExecutorResult` with frozen sub-objects. Immutability is enforced at the boundary.

## Notes

- The "one bad scenario package shouldn't fail the others" requirement is correctly implemented at `cli/sim.ts:186-230` — each package import is wrapped in try/catch and surfaces to stderr without aborting the loop. Good.
- `LegacyLoadResultPayload` is `@deprecated` but still wired through (the load builder returns it, custom executors return it). Either retire it or stop calling it legacy — currently both. See F7.
- `getEstimatedRps` in `framework/personas.ts:174` is consumed by the load window driver but lives in a "personas" file. It's a tiny seam but worth noting that the load driver's coupling to persona spawn rates is implicit (the personas file owns the RPS estimator that the loop uses). When/if the load model evolves to time-varying RPS profiles, this estimator becomes the wrong abstraction.
- The fitness/simulation symmetry called out in the audit prompt is good in shape (Tool contract, recipe registry, plugin loader, lifecycle hook) but diverges in implementation: fitness's loader is a single `loadAllPlugins('fit', ...)` call, simulation's `loadAllSimPlugins` is a custom outer loop because of F1. Resolving F1 collapses this divergence.
- The `predicateRegistry` and `scenarioRegistry` are both module-level singletons, but the predicate registry has `resetPredicateRegistryToBaseline()` while the scenario registry has only `clearScenarioRegistry()`. Symmetric API would help — the predicate registry's "reset to framework-shipped baseline" is the more useful test primitive.
