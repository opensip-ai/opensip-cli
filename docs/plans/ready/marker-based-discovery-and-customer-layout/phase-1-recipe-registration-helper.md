# Phase 1: Recipe-registration helper

**Goal:** Extract a shared `registerRecipesFromMod<R>(mod, registry, options)` helper in core that codifies the careful loader.ts pattern (warn on malformed, narrow catch on duplicate). The helper becomes the single recipe-registration implementation; Phases 3 and 4 migrate all three sites to call it.

**Depends on:** —

---

## Task 1.1: Add the helper module

**Files:** [size: M]
- Create: `packages/core/src/plugins/recipe-loader.ts`
- Create: `packages/core/src/plugins/__tests__/recipe-loader.test.ts` (scaffold — Phase 7 fills in)

**Context:** Today there are two near-identical recipe-registration sites that already diverge:

- `packages/fitness/engine/src/plugins/loader.ts:109-127` — the *careful* implementation. Shape-checks each recipe (`'id' in recipe && 'name' in recipe`); on duplicate, swallows in try/catch; on malformed, emits a `plugin.loader.invalid_recipe_item` warning through the loader context's `ctx.warn` channel.
- `packages/simulation/engine/src/cli/sim.ts:188-201` — the *looser* implementation. Shape-checks the same way but silently drops malformed items.

Both implementations use the same unqualified `catch {}` to skip duplicates, which is incorrect — a genuine register error (schema validation, registry internal failure) would be misattributed as a duplicate. The shared helper fixes this by narrowing the catch.

The helper takes a generic recipe registry, an unknown-typed mod that may export `recipes`, and an options bag carrying:
- `namespace: string` — used in warning messages so the customer can identify the offending pack
- `onWarn: (evt: string, message: string, extra?: object) => void` — adapts loader.ts's `ctx.warn` and the CLI's `logger.warn` to a common interface
- (optional) `onDuplicate?: (recipe: R) => void` — invoked when a recipe is rejected as a duplicate; defaults to no-op

The narrow catch: the registry's `register` method throws a typed error (`RecipeAlreadyRegisteredError` — see `packages/core/src/registries/recipe-registry.ts` for the existing throw site). The helper catches only that specific error class; anything else re-throws so the caller's outer try/catch picks it up.

**Steps:**

1. Create `packages/core/src/plugins/recipe-loader.ts` with:

   ```typescript
   import { RecipeRegistry, RecipeAlreadyRegisteredError } from '../registries/recipe-registry.js';

   export interface RegisterRecipesOptions<R> {
     readonly namespace: string;
     readonly onWarn: (evt: string, message: string, extra?: Record<string, unknown>) => void;
     readonly onDuplicate?: (recipe: R) => void;
   }

   export interface RegisterRecipesResult {
     readonly recipesRegistered: number;
   }

   export function registerRecipesFromMod<R extends { readonly id: string; readonly name: string }>(
     mod: unknown,
     registry: RecipeRegistry<R>,
     options: RegisterRecipesOptions<R>,
   ): RegisterRecipesResult;
   ```

2. Implementation outline:
   - Read `mod.recipes` via a safe-typed cast (`(mod as { recipes?: unknown }).recipes`).
   - If not an array, return `{ recipesRegistered: 0 }`.
   - For each item at `index i`:
     - Shape check: `recipe && typeof recipe === 'object' && 'id' in recipe && 'name' in recipe`. If fails, `onWarn('plugin.recipe.invalid_item', '<namespace> recipes[<i>] is not a valid Recipe object (missing id or name) — skipping.', { index: i })`. Continue.
     - Try `registry.register(recipe as R, { allowOverwrite: false })`. Increment counter on success.
     - Catch: if `err instanceof RecipeAlreadyRegisteredError`, call `onDuplicate?.(recipe as R)` and continue. Otherwise re-throw.

3. **If `RecipeAlreadyRegisteredError` does not currently exist** as a typed export from `packages/core/src/registries/recipe-registry.ts`: add it. The existing `register` method already throws on duplicate (per the `allowOverwrite: false` semantics); confirm by reading that file. If the thrown error is plain (string message), introduce `RecipeAlreadyRegisteredError extends Error` with a constructor that takes the recipe id/name; replace the throw site to use it. This is a small, justified expansion — the narrow catch needs a typed handle.

4. Add a scaffold test `__tests__/recipe-loader.test.ts` with one placeholder `it`. Phase 7 fills in cases for: happy path, malformed-recipe warning, duplicate skip, non-duplicate error re-throw, non-array `mod.recipes` early return.

**Wiring:** Called by:
- `packages/fitness/engine/src/plugins/loader.ts` after Phase 3 migration (loader context wraps `ctx.warn` as the `onWarn` callback).
- `packages/fitness/engine/src/cli/fit.ts` in Phase 3 (passes `logger.warn`-style adapter).
- `packages/simulation/engine/src/cli/sim.ts` in Phase 4.

No call sites in this phase — the helper is exported and tested in isolation.

**Verification:**
```bash
pnpm --filter=@opensip-tools/core build
pnpm --filter=@opensip-tools/core typecheck
pnpm --filter=@opensip-tools/core test
```

**Commit:** `feat(core): shared recipe-registration helper with narrow-catch + malformed-warning`

---

## Task 1.2: Export from core barrel

**Files:** [size: XS]
- Modify: `packages/core/src/plugins/index.ts`
- Modify: `packages/core/src/index.ts`

**Steps:**

1. In `packages/core/src/plugins/index.ts`, add:
   ```typescript
   export { registerRecipesFromMod } from './recipe-loader.js';
   export type {
     RegisterRecipesOptions,
     RegisterRecipesResult,
   } from './recipe-loader.js';
   ```

2. In `packages/core/src/index.ts`, re-export. Also re-export `RecipeAlreadyRegisteredError` if Task 1.1 introduced it.

**Wiring:** Once exported, fit (Phase 3) and sim (Phase 4) consume via `@opensip-tools/core`.

**Verification:**
```bash
pnpm --filter=@opensip-tools/core build
pnpm typecheck
```

**Commit:** `feat(core): export registerRecipesFromMod from plugins barrel`

---

## Phase 1 End-to-End Verification

- `pnpm --filter=@opensip-tools/core test` passes.
- `pnpm typecheck` across the workspace — no consumer site change yet; existing consumers of `RecipeRegistry` (if any imported the typed error) compile.
- `pnpm lint` — 0 errors.

> **Deferred:** Observability — the helper emits `plugin.recipe.invalid_item` events through the caller's `onWarn`. The string is namespaced to `plugin.recipe.*` rather than tool-specific (`plugin.loader.invalid_recipe_item` was loader.ts's name) to reflect that the helper is the new home for this warning. Existing log-consumers grepping the old name need to migrate; track in release notes.
