# Phase 3: Migrate tool-owned registries

**Goal:** Migrate every remaining registry class (fitness ×3, simulation ×2, graph ×2, dashboard ×1) to `Registry<T>`. Kill the `SimulationRecipeRegistry` LSP violation. Each task is a separate commit on the same PR so individual migrations can be reverted without unrolling the whole phase.

**Depends on:** Phase 2 (all core registries migrated; `Registry<T>` is the only base in core).

This is the largest phase by file count but each task is mechanical: replace internal Maps with a `Registry<T>` instance, preserve the package's public API (`register(...)`, `getAll(...)`, lookup methods), keep events flowing. Each task touches exactly one consumer.

---

## Task 3.1: Migrate `CheckRegistry` (fitness)

**Files:**
- Modify: `packages/fitness/engine/src/framework/registry.ts`

**Context:** Current behaviour: silent skip on duplicate (`framework/registry.ts:25`, comment says "Silently skip duplicate — same check imported multiple times"). Maps to `duplicatePolicy: 'silent-skip'`.

**Steps:**
1. Replace internal Maps with `new Registry<Check>({ module: 'fitness:checks', duplicatePolicy: 'silent-skip', evtPrefix: 'check.registry' })`.
2. Preserve `register`, `getAll`, `getBySlug`, `getByTag`, scope-filtering helpers as wrappers around `inner.*`.
3. The slug-based lookup (`getBySlug`) needs special handling — `slug` isn't `id` or `name` directly. Either: (a) reshape `Check` so its `slug` equals its `name`, or (b) add a `bySlug` Map alongside the `inner` Registry. Phase 0 Task 0.1 should have flagged this; pick (a) if `slug` is canonically `name`-shaped, otherwise (b).

**Observability:** `evt: 'check.registry.*'` (new). Prior `CheckRegistry` did not emit on duplicate — switching to the silent-skip policy maintains the silent behaviour; no events.

**Wiring:** None outside fitness.

**Error cases:** No throws. Silent skip preserved.

**Verification:**
```bash
pnpm --filter @opensip-tools/fitness build
pnpm --filter @opensip-tools/fitness test
pnpm --filter @opensip-tools/checks-typescript test  # downstream consumers
```

**Commit:** `refactor(fitness): CheckRegistry on top of Registry<T>`

---

## Task 3.2: Migrate `FitnessRecipeRegistry`

**Files:**
- Modify: `packages/fitness/engine/src/recipes/registry.ts`

**Context:** Throw-on-duplicate by default. Constructor loads built-in recipes — per Phase 0 Task 0.2 decision (b), built-ins now register via `super.registerAll(builtIns, { internal: true })` instead of populating maps in the constructor.

**Steps:**
1. Extend `RecipeRegistry<FitnessRecipe>` (the migrated core class) with `module: 'fitness:recipes'`, `validationCode: 'VALIDATION.FITNESS.DUPLICATE_RECIPE'`.
2. Move built-in registration out of the constructor into a factory: `export function createDefaultFitnessRecipeRegistry(): FitnessRecipeRegistry`. The default export becomes `export const defaultFitnessRecipeRegistry = createDefaultFitnessRecipeRegistry()` (one line).
3. `reset()` method calls `inner.clear()` + re-registers built-ins via `{ internal: true }`.

**Observability:** Same `recipe.registry.duplicate` event shape (inherited from `RecipeRegistry`).

**Wiring:** `defaultFitnessRecipeRegistry` export preserved.

**Error cases:** `register(userRecipe)` with duplicate name/id of a built-in still throws — `{ internal: true }` is *only* used at seed time, not at `register()` time.

**Verification:**
```bash
pnpm --filter @opensip-tools/fitness test src/recipes/__tests__/
```

**Commit:** `refactor(fitness): FitnessRecipeRegistry uses createDefault factory + Registry<T> base`

---

## Task 3.3: Migrate `TargetRegistry` (fitness)

**Files:**
- Modify: `packages/fitness/engine/src/targets/target-registry.ts`

**Context:** Phase 0 Task 0.1 records the current behaviour. Common case: targets are looked up by name; duplicate-name handling TBD-from-Phase-0.

**Steps:**
1. Read the file. Identify the duplicate-handling code.
2. Pick the matching `DuplicatePolicy` (per Phase 0's table for this row).
3. Replace internal Maps with `new Registry<TargetDescriptor>(...)`.
4. Domain-specific accessors (e.g. `forFilePath(filePath)` if it exists) live alongside, not on the base.

**Observability:** New event prefix `evt: 'target.registry.*'`.

**Wiring:** None outside fitness.

**Verification:**
```bash
pnpm --filter @opensip-tools/fitness test
```

**Commit:** `refactor(fitness): TargetRegistry on top of Registry<T>`

---

## Task 3.4: Fix `SimulationRecipeRegistry` LSP violation

**Files:**
- Modify: `packages/simulation/engine/src/recipes/registry.ts`
- Modify: `packages/core/src/recipes/registry.ts` (remove the temp `byId`/`byName` shim from Phase 2 Task 2.3)

**Context:** Today this class writes directly to its parent's `protected byId`/`byName` Maps (`simulation/engine/src/recipes/registry.ts:32-39`) because the parent's `register()` would throw on the second built-in. Per Phase 0 Task 0.3 decision (A), the fix is `super.registerAll(builtIns, { internal: true })`.

**Steps:**
1. Rewrite `SimulationRecipeRegistry`:

   ```typescript
   import { builtInSimulationRecipes } from './built-in-recipes.js';
   import type { SimulationRecipe } from './types.js';
   import { RecipeRegistry } from '@opensip-tools/core';

   export class SimulationRecipeRegistry extends RecipeRegistry<SimulationRecipe> {
     constructor() {
       super({
         module: 'simulation:recipes',
         validationCode: 'VALIDATION.SIMULATION.DUPLICATE_RECIPE',
       });
       // Built-ins bypass the duplicate guard via { internal: true } —
       // no more direct map writes; LSP holds.
       this.registerAll(builtInSimulationRecipes, { internal: true });
     }

     override register(recipe: SimulationRecipe, opts?: { allowOverwrite?: boolean }): void {
       super.register(recipe, {
         allowOverwrite: opts?.allowOverwrite ?? false,
         throwOnDuplicate: !(opts?.allowOverwrite ?? false),
       });
     }

     reset(): void {
       this.clear();
       this.registerAll(builtInSimulationRecipes, { internal: true });
     }

     // listForDisplay() unchanged — uses public accessors.
     listForDisplay(): readonly SimulationRecipeDisplayInfo[] {
       return this.getAll().map((recipe) => {
         const isUser = recipe.id.startsWith('URCP_');
         return {
           name: recipe.name,
           displayName: recipe.displayName,
           description: recipe.description,
           tags: recipe.tags ?? [],
           isBuiltIn: !isUser && BUILT_IN_NAMES.has(recipe.name),
           isUserDefined: isUser,
         };
       });
     }
   }
   ```

2. Remove the temp `protected byId`/`byName` shim from `core/recipes/registry.ts` introduced in Phase 2 Task 2.3.

3. **New test:** "registering a user recipe with the same name as a built-in throws ValidationError, but the built-in itself was loaded via { internal: true } without firing the throw at constructor time." This was the bypass the LSP violation hid.

**Observability:** Same `recipe.registry.duplicate` event. Plus a new test-only signal: the built-in registration now flows through `Registry.register` with `{ internal: true }`, so any future observability hook on registration fires — previously the built-ins were invisible to the registry.

**Wiring:** None outside simulation.

**Error cases:** User-recipe duplicates still throw. The constructor no longer throws (which it couldn't before via direct map writes, but now it provably doesn't via the policy).

**Verification:**
```bash
pnpm --filter @opensip-tools/simulation test
pnpm --filter @opensip-tools/core test     # temp shim removal validation
```

**Commit:** `fix(simulation): SimulationRecipeRegistry LSP violation — built-ins via { internal: true }`

---

## Task 3.5: Migrate simulation framework registry (wraps ex-`IdNameTagRegistry`)

**Files:**
- Modify: `packages/simulation/engine/src/framework/registry.ts`

**Context:** Touched in Phase 2 Task 2.4 as part of `IdNameTagRegistry` deletion. This task just verifies the migration landed cleanly and adjusts any simulation-specific helpers that wrap it.

**Steps:**
1. Confirm the file now reads `new Registry<RunnableScenario>({ ... silent-skip + nameCollisionMode: 'throw' ... })`.
2. Update any simulation-specific helpers (`getByKind`, etc.) to use the new accessor names.

**Observability:** Per Phase 2 Task 2.4 — new `scenario.registry.*` event prefix.

**Wiring:** None outside simulation.

**Verification:**
```bash
pnpm --filter @opensip-tools/simulation test
```

**Commit:** `refactor(simulation): framework registry uses Registry<T> directly`

---

## Task 3.6: Migrate graph language-adapter registry

**Files:**
- Modify: `packages/graph/engine/src/lang-adapter/registry.ts`

**Context:** Phase 0 Task 0.1 records the current behaviour. Likely first-writer-wins like `LanguageRegistry`.

**Steps:**
1. Replace internal Maps with `new Registry<GraphLanguageAdapter>({ module: 'graph:lang-adapter', duplicatePolicy: 'warn-first-wins', evtPrefix: 'graph.lang_adapter.registry' })`.
2. Preserve `pickAdapter(cwd)` and any other domain-specific helpers alongside.
3. Update `_clearAdaptersForTesting` to call `inner.clear()`.

**Observability:** `evt: 'graph.lang_adapter.registry.duplicate'` (new shape).

**Wiring:** None outside graph.

**Verification:**
```bash
pnpm --filter @opensip-tools/graph test
```

**Commit:** `refactor(graph): lang-adapter registry on top of Registry<T>`

---

## Task 3.7: Migrate graph rules registry

**Files:**
- Modify: `packages/graph/engine/src/rules/registry.ts`

**Context:** 25 LOC file — currently an array push. The duplicate-id behaviour is undefined today (no guard). Migrate to a real registry with `duplicatePolicy: 'warn-first-wins'`.

**Steps:**
1. Replace the array with `new Registry<Rule>({ module: 'graph:rules', duplicatePolicy: 'warn-first-wins', evtPrefix: 'graph.rule.registry' })`.
2. Preserve `defaultRules` (an array snapshot) as a getter that returns `registry.getAll()`.
3. Verify no consumer relies on the array shape (`defaultRules.push(...)`); if any does, refactor to call `register(rule)`.

**Observability:** New event prefix.

**Wiring:** None outside graph.

**Verification:**
```bash
pnpm --filter @opensip-tools/graph test
```

**Commit:** `refactor(graph): rules registry on top of Registry<T>`

---

## Task 3.8: Migrate dashboard `ToolTabRegistry`

**Files:**
- Modify: `packages/dashboard/src/tool-tab-registry.ts`

**Context:** Per Phase 0 Task 0.1, decide whether this fits the `Registry<T>` shape. It uses a tab-id key, possibly not the `{ id, name, tags }` shape. If it doesn't fit cleanly, *leave it as-is* — the cross-cutting report (T2) noted the dashboard registry has a different shape and may stay separate.

**Steps:**
1. Read the file.
2. If `ToolTabDescriptor` has `{ id, name }`-shape: migrate.
3. If not: document the decision in this task with one sentence — "ToolTabRegistry does not fit Registerable's shape because <reason>" — and leave the file untouched.

**Observability:** Either new `tab.registry.*` events or unchanged.

**Wiring:** None outside dashboard.

**Verification:**
```bash
pnpm --filter @opensip-tools/dashboard test
```

**Commit:** `refactor(dashboard): ToolTabRegistry on top of Registry<T>` OR `chore(dashboard): document ToolTabRegistry's non-fit with Registry<T>`

---

## End-of-phase verification

```bash
pnpm typecheck && pnpm test && pnpm lint
grep -rn "IdNameTagRegistry" packages/                                  # zero matches (from Phase 2)
grep -rn "this\.byId\.set\|this\.byName\.set" packages/                 # zero matches in tool registries (LSP fixed)
grep -rn "protected\s\+readonly\s\+byId\|protected\s\+readonly\s\+byName" packages/  # only inside Registry<T> itself
```

Acceptance:

- [ ] All seven tool registries (fitness ×3, simulation ×2, graph ×2 — dashboard either ×1 or documented exception) are thin subclasses or direct uses of `Registry<T>`.
- [ ] `SimulationRecipeRegistry` does not access any `protected` member of its parent. The LSP violation is gone.
- [ ] Temp `protected byId`/`byName` shim removed from `core/recipes/registry.ts`.
- [ ] LOC across all migrated files dropped by ≥ 30% vs Phase 2 baseline (target: ~600 LOC across the 7 files vs ~700 before).
- [ ] `pnpm typecheck`, `pnpm test`, `pnpm lint` all green at each task boundary.
- [ ] PR reviewable: each commit (Tasks 3.1 – 3.8) is independent and revertible.
