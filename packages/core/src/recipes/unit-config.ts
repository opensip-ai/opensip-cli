/**
 * @fileoverview Per-unit recipe configuration accessors — the generic
 * half of the recipe substrate's config-override surface.
 *
 * A recipe can carry a `config` map keyed by unit slug (checks today,
 * rules in a later phase). The recipe service projects this map into the
 * current `RunScope`'s `recipeUnitConfig` slot before any unit runs and
 * clears it once the run completes. Each unit reads its slice via
 * `getUnitConfig<T>(slug)` and merges it with its built-in defaults.
 *
 * Scope-bound (not module-bound) lookup is load-bearing — the runtime
 * frequently has TWO copies of a tool package loaded:
 *
 *   1. The CLI's bundled copy (running the recipe service).
 *   2. A plugin pack's resolved copy (running the unit, calling
 *      `getUnitConfig(slug)`).
 *
 * Each copy has its own module-scope state. Routing through
 * `currentScope()` binds the slot identity to core (a single resolved
 * copy in every npm graph) rather than to whichever tool copy loaded
 * first. (See `packages/fitness/engine/src/recipes/check-config.ts` for
 * the original, fitness-named accessors that now re-export these.)
 *
 * Calling `getUnitConfig(...)` outside any `runWithScope` (e.g. unit
 * tests that don't set up a scope) returns an empty object — the unit's
 * own defaults handle the empty case.
 *
 * The slot name (`recipeUnitConfig`) and its `RecipeUnitConfigSlot`
 * type are now unit-neutral, matching the generalized accessors and map type.
 */

import { currentScope } from '../lib/run-scope.js';

import type { RunScope } from '../lib/run-scope.js';

/**
 * Per-unit configuration map. Keys are unit slugs; values are
 * unit-specific config objects whose shape the consuming unit declares.
 */
export type RecipeUnitConfigMap = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

/**
 * Read the per-unit config slice for the given slug.
 *
 * Returns an empty object when no recipe-config has been set or no entry
 * exists for the slug — treat the result as "augmentation only" and merge
 * with the unit's own defaults. The stored entry is returned cast to `T`
 * without runtime validation; each unit owns its defaults and tolerates
 * the empty case.
 *
 * @typeParam T - The shape the calling unit expects.
 */
export function getUnitConfig<T extends Record<string, unknown>>(slug: string): T {
  const scope = currentScope();
  const entry = scope?.recipeUnitConfig.get<T>(slug);
  if (!entry) return {} as T;
  return entry;
}

/**
 * Replace the current scope's recipe config. Called by a recipe service at
 * the start of a recipe run, before any unit executes.
 *
 * Takes a scope explicitly rather than reading `currentScope()` so callers
 * make the scope boundary explicit and lifecycle errors surface as type
 * errors rather than silently no-op'ing outside a scope.
 */
export function setCurrentRecipeUnitConfig(
  scope: RunScope,
  config: RecipeUnitConfigMap | undefined,
): void {
  scope.recipeUnitConfig.setAll(config ?? {});
}

/**
 * Clear the current scope's recipe config. Called by a recipe service at
 * the end of a recipe run (success or failure).
 */
export function clearCurrentRecipeUnitConfig(scope: RunScope): void {
  scope.recipeUnitConfig.clear();
}
