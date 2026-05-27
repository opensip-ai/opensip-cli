# Phase 6: Eliminate side-effect registration

**Goal:** Remove the remaining module-level side-effect patterns: `defineX` mutating `scenarioRegistry` at import time; the `Symbol.for(globalThis)` slot for fitness recipe config; the lang-typescript `filterCache` separate from `parseCache`; the simulation plugin loader's snapshot-delta accounting (`plugins/loader.ts:108-133`). After this phase, *every* per-run resource lives on `RunScope` and *every* registration is explicit.

**Depends on:** Phase 5 (`RunScope` threaded through `ToolCliContext`).

This is the keystone phase — the cross-cutting T1 finding's resolution lives here. Most of the test plumbing (`...WithoutRegistration` twins, `clearScenarioRegistry`, `clearFilterCache`, `_clearAdaptersForTesting` in graph, `reset()` on FitnessRecipeRegistry) disappears in this phase.

---

## Task 6.1: `defineX` returns scenarios without registering

**Files:**
- Modify: `packages/simulation/engine/src/kinds/load/define.ts`
- Modify: `packages/simulation/engine/src/kinds/chaos/define.ts`
- Modify: `packages/simulation/engine/src/kinds/invariant/define.ts`
- Modify: `packages/simulation/engine/src/kinds/fix-evaluation/define.ts`
- Modify: `packages/simulation/engine/src/index.ts` (remove `...WithoutRegistration` exports)
- Modify: scenario authors (project-local and check packs) — every site that wrote `defineLoadScenario({...})` expecting auto-registration

**Context:** Today's flow: `defineLoadScenario(config)` returns a `RunnableScenario` AND calls `scenarioRegistry.register(scenario)`. The `defineLoadScenarioWithoutRegistration(config)` twin exists for tests. Both will collapse to a single function that returns the scenario only. Callers (loaders, scenario packs) call `scope.scenarios.register(scenario)` explicitly.

**Steps:**

1. In each `define.ts`, remove the `scenarioRegistry.register(scenario)` line. The function returns the scenario object only.

2. Delete the `...WithoutRegistration` variants. They were workarounds for "this define call shouldn't register — but the other one in this file should." With no auto-registration, there's nothing to opt out of.

3. Remove the `...WithoutRegistration` re-exports from `simulation/engine/src/index.ts:52`, `:65`, `:78`, `:100`.

4. Update scenario authors. Two patterns:
   - **Scenario packs** (npm packages exporting `scenarios: [...]`): no change at the author level — they were already returning scenarios. The plugin loader was using import-side-effects, but the published surface is the `scenarios` array. The loader's snapshot-delta math (Task 6.3) goes away.
   - **Project-local scenarios** (`opensip-tools/sim/scenarios/*.mjs`): previously they wrote `defineLoadScenario({...})` at module top-level for the side effect. Now they must `export const scenarios = [defineLoadScenario({...}), ...]`. The plugin loader reads `module.scenarios`.

5. **Runtime guard for migration aids:** scenarios that were called but never registered are easy to author by accident. Add a debug-mode check in the loader that warns when a module imports `defineLoadScenario` (etc.) but exports no `scenarios` array — likely a missed migration. Off by default; gated behind `--debug`.

**Observability:** New event `evt: 'sim.scenarios.loaded'`, `count: N` fires once per loaded module from the plugin loader (which is now the *only* registration site).

**Wiring:** `scope.registries.scenarios` is the registration target. Loaders construct or read it from scope.

**Error cases:** A scenario pack that exports no `scenarios` array is logged as a warning at debug level, not an error — the pack might just be a helper module with no scenarios in this version.

**Verification:**
```bash
pnpm --filter @opensip-tools/simulation build
pnpm --filter @opensip-tools/simulation test
grep -rn "WithoutRegistration" packages/                # zero matches
grep -rn "scenarioRegistry\.register" packages/         # only in the plugin loader
```

**Commit:** `refactor(simulation): defineX returns scenarios; explicit registration via plugin loader`

---

## Task 6.2: Replace `Symbol.for(globalThis)` recipe config with scope-bound lookup

**Files:**
- Modify: `packages/fitness/engine/src/recipes/check-config.ts`
- Modify: `packages/fitness/engine/src/recipes/service.ts` (where the slot is set/cleared)
- Modify: any check that reads `getCheckConfig(slug)` — should be no change at the call site

**Context:** Per Phase 0 Task 0.4 decision (B), `getCheckConfig(slug)` switches from `globalThis[GLOBAL_KEY]` to `currentScope()?.recipeCheckConfig.get(slug)`. The "two copies of fitness loaded" hazard is solved by ALS — both copies of fitness import the same `AsyncLocalStorage` from `@opensip-tools/core`, so the slot is process-global by virtue of the *core* module identity, not fitness's.

**Steps:**

1. Rewrite `packages/fitness/engine/src/recipes/check-config.ts`:

   ```typescript
   import { currentScope, logger } from '@opensip-tools/core';
   import type { ZodType } from 'zod';

   export function getCheckConfig<T extends Record<string, unknown>>(slug: string): T;
   export function getCheckConfig<T extends Record<string, unknown>>(slug: string, schema: ZodType<T>): T;
   export function getCheckConfig<T extends Record<string, unknown>>(slug: string, schema?: ZodType<T>): T {
     const scope = currentScope();
     const entry = scope?.recipeCheckConfig.get<T>(slug);
     if (!entry) return {} as T;
     if (!schema) return entry;
     const parsed = schema.safeParse(entry);
     if (!parsed.success) {
       logger.warn({
         evt: 'fitness.check_config.invalid',
         module: 'fitness:check-config',
         checkSlug: slug,
         issues: parsed.error.issues,
         msg: `Recipe-supplied config for check '${slug}' failed schema validation; falling back to defaults.`,
       });
       return {} as T;
     }
     return parsed.data;
   }

   /** Replaces setCurrentRecipeCheckConfig. Called by the recipe service before checks run. */
   export function setRecipeCheckConfig(scope: RunScope, config: RecipeCheckConfigMap | undefined): void {
     scope.recipeCheckConfig.setAll(config ?? {});
   }

   export function clearRecipeCheckConfig(scope: RunScope): void {
     scope.recipeCheckConfig.clear();
   }
   ```

2. Update `service.ts` to call `setRecipeCheckConfig(scope, recipe.checks.config)` before running checks and `clearRecipeCheckConfig(scope)` in the `finally`. The `scope` comes from `currentScope()` since the engine is now invoked inside `runWithScope`.

3. Delete the `GLOBAL_KEY` symbol and `slot()` helper. Delete the `Symbol.for('@opensip-tools/fitness/currentRecipeCheckConfig')` literal.

4. **Two-copies-of-fitness test:** add an integration test that imports `getCheckConfig` from two *different* paths (one via the workspace symlink, one via `node_modules/.pnpm/...` directly), runs both inside a single `runWithScope`, and verifies both see the same config. This pins the ALS hazard fix from Phase 4 Task 4.2's comment.

**Observability:** Event `fitness.check_config.invalid` preserved.

**Wiring:** `service.ts`'s setter/clearer takes a scope arg. Every check still calls `getCheckConfig(slug)` unchanged.

**Error cases:** `getCheckConfig` outside a scope (e.g. tested directly) returns `{}` rather than throwing — the check's own defaults handle the empty case.

**Verification:**
```bash
pnpm --filter @opensip-tools/fitness test
grep -rn "Symbol\.for\s*\(\s*['\"]@opensip-tools/fitness" packages/   # zero matches
grep -rn "globalThis\[GLOBAL_KEY\]\|slot()\[GLOBAL_KEY\]" packages/   # zero matches
```

**Commit:** `refactor(fitness): scope-bound recipe config, no globalThis slot`

---

## Task 6.3: Collapse simulation plugin loader snapshot-delta math

**Files:**
- Modify: `packages/simulation/engine/src/plugins/loader.ts` (lines 108-133 per the audit)

**Context:** Today, the simulation plugin loader observes scenario registrations by *taking a registry-size snapshot before and after import* and assuming the delta = scenarios from this module. With Task 6.1 eliminating side-effect registration, the loader reads `module.scenarios` directly.

**Steps:**

1. Read the current loader. Identify the snapshot-delta block (~25 lines per the audit).
2. Rewrite as:

   ```typescript
   const mod = await import(packageEntryPoint);
   if (Array.isArray(mod.scenarios)) {
     for (const scenario of mod.scenarios) {
       scope.registries.scenarios.register(scenario);
     }
     logger.info({
       evt: 'sim.scenarios.loaded',
       module: 'simulation:plugin-loader',
       package: packageName,
       count: mod.scenarios.length,
     });
   }
   if (Array.isArray(mod.recipes)) {
     for (const recipe of mod.recipes) {
       scope.simulationRecipes.register(recipe);  // or wherever recipes register
     }
   }
   ```

3. Delete the snapshot-before / snapshot-after / `for-of` over `delta` block.

**Observability:** New `sim.scenarios.loaded` event with `count`. Replaces the absence of any registration-observability today.

**Wiring:** Loader reads the same module shapes (`mod.scenarios`, `mod.recipes`) that npm packages already export. No third-party impact.

**Error cases:** A plugin that exports neither `scenarios` nor `recipes` is logged at debug level and not registered — that's a useless plugin and the user should see why.

**Verification:**
```bash
pnpm --filter @opensip-tools/simulation test
pnpm --filter @opensip-tools/cli test  # e2e simulating a project with sim packages
```

**Commit:** `refactor(simulation): plugin loader reads module.scenarios directly`

---

## Task 6.4: Fold lang-typescript `filterCache` into `scope.parseCache`

**Files:**
- Modify: `packages/languages/lang-typescript/src/filter.ts`
- Modify: any consumer that calls `clearFilterCache()` (test files)

**Context:** `lang-typescript/src/filter.ts:145` maintains a separate `filterCache: Map<string, string>` with its own 10-minute timer, distinct from `LanguageParseCache`. Both keys are file-path-based. Lifetimes are identical. Merging them removes one singleton.

**Steps:**

1. Either (a) extend `LanguageParseCache` with a `filteredContent` value type alongside the parsed tree, or (b) introduce a `scope.filteredContentCache` on RunScope as a sibling of `parseCache`. Pick (a) — the parsed tree and the filtered content are paired anyway (you filter to feed the parser).

2. Refactor `filter.ts` to accept a `parseCache: LanguageParseCache` arg (or read from `currentScope()?.parseCache`). Delete the module-level `filterCache` and its timer.

3. Delete `clearFilterCache()` export.

4. Test files that called `clearFilterCache()` switch to `scope.parseCache.clear()` (or rely on `scope.dispose()`).

**Observability:** None.

**Wiring:** `LanguageParseCache` adds a `filteredContent: Map<string, string>` field (or an alias method).

**Error cases:** None expected.

**Verification:**
```bash
pnpm --filter @opensip-tools/lang-typescript test
pnpm --filter @opensip-tools/checks-typescript test
grep -rn "filterCache\|clearFilterCache" packages/   # zero matches
```

**Commit:** `refactor(lang-typescript): merge filterCache into scope.parseCache`

---

## Task 6.5: Remove `setLogLevel` and other free mutators of `logger`

**Files:**
- Modify: `packages/core/src/lib/logger.ts`
- Modify: every caller of `setLogLevel`

**Context:** `logger.ts:231` exports a mutable singleton. The mutators (`setLogLevel`, etc.) modify it in place. With RunScope owning the logger, mutations happen on `scope.logger` directly — but for the bootstrap path, `setLogLevel` is invoked before the scope is constructed (CLI parses `--debug` and bumps the level).

**Steps:**

1. Add `LoggerOptions { level: 'debug' | 'info' | 'warn' | 'error' }` if not present.
2. The bootstrap parses CLI flags first, then constructs `new RunScope({ logger: createLogger({ level }) })`. No mutation of an existing logger.
3. Replace every `setLogLevel(x)` call with construction.
4. The exported `logger` constant survives as a *default-options* convenience for code that's not yet scope-aware. It's not mutable anymore — `setLogLevel` is deleted.
5. The pre-action hook's flow becomes: parse flags → construct scope with configured logger → enter `runWithScope`.

**Observability:** `cli.logger.level` event at debug level on construction (existing event in `logger.ts` — preserved).

**Wiring:** `logger` import remains for cases where no scope is reachable (e.g. very-early bootstrap before flags parsed). Once a scope exists, code uses `scope.logger`.

**Error cases:** None.

**Verification:**
```bash
grep -rn "setLogLevel" packages/   # zero matches
pnpm typecheck && pnpm test
```

**Commit:** `refactor(core): logger constructed with options, no free mutators`

---

## Task 6.6: Delete test plumbing for module-level resets

**Files:**
- Modify: every `*.test.ts` that calls `clearScenarioRegistry`, `_clearAdaptersForTesting`, `clearParseCache`, `clearFilterCache`, `reset()` on FitnessRecipeRegistry

**Context:** Each test that constructs a fresh scope per `beforeEach` doesn't need these resets — the scope is the test's universe. Removing them is the metric that proves the refactor worked.

**Steps:**

1. Grep all `clearXForTesting()`, `_clearAdaptersForTesting()`, `WithoutRegistration` calls in test files.
2. For each: replace `beforeEach` setup with `const scope = new RunScope({...})` + wrap test bodies in `runWithScope(scope, async () => {...})`.
3. Delete the `clearX` exports from source files.

**Observability:** None.

**Wiring:** Test-only.

**Error cases:** If a test was relying on observable state across `beforeEach` boundaries (anti-pattern), the fresh-scope-per-test will surface that as a failing test. Fix the test, not the harness.

**Verification:**
```bash
grep -rn "_clearAdaptersForTesting\|clearScenarioRegistry\|clearFilterCache\|clearParseCache" packages/   # zero matches outside legacy compat shims
pnpm test
```

**Commit:** `test: replace per-test resets with fresh RunScope per beforeEach`

---

## End-of-phase verification

```bash
pnpm typecheck && pnpm test && pnpm lint
pnpm fit                                          # dogfood gate
grep -rn "Symbol\.for\(.*opensip-tools" packages/  # zero matches
grep -rn "scenarioRegistry\.register" packages/    # only inside the plugin loader
grep -rn "WithoutRegistration" packages/           # zero matches
grep -rn "filterCache\b" packages/                  # zero matches
grep -rn "setLogLevel\b" packages/                  # zero matches
grep -rn "_clearAdaptersForTesting\|clearScenarioRegistry" packages/   # zero matches
```

Acceptance:

- [ ] `defineX` functions return scenarios without registering. `...WithoutRegistration` twins deleted.
- [ ] `Symbol.for('@opensip-tools/fitness/currentRecipeCheckConfig')` is no longer read or written.
- [ ] Simulation plugin loader's snapshot-delta block is replaced with a `module.scenarios` read.
- [ ] `lang-typescript` no longer maintains a separate `filterCache`.
- [ ] `setLogLevel` and other free mutators are gone; logger is constructed.
- [ ] Test plumbing (`clearXForTesting`, etc.) deleted in favour of per-test scope construction.
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm fit` all green.
