/**
 * @fileoverview Per-check recipe configuration plumbing.
 *
 * Recipes can carry a `checks.config` map keyed by check slug. The recipe
 * service projects this map into the current `RunScope`'s
 * `recipeCheckConfig` slot before any check runs and clears it once the
 * run completes.
 *
 * Individual checks read their slice via `getCheckConfig<T>(slug)` —
 * typically once at module load (when imported by the registry) or at
 * the top of `analyze` — and merge it with their built-in defaults.
 *
 * Scope-bound (not module-bound) lookup is load-bearing — the runtime
 * frequently has TWO copies of `@opensip-tools/fitness` loaded:
 *
 *   1. The CLI's bundled copy (running the recipe service).
 *   2. The plugin pack's resolved copy (running the check, calling
 *      `getCheckConfig(slug)`).
 *
 * Each copy has its own module-scope state. The previous design used a
 * `Symbol.for(globalThis)` slot so both copies pointed at the same
 * process-global storage. The current design routes through
 * `currentScope()` from `@opensip-tools/core` — both fitness copies
 * import the same `AsyncLocalStorage` instance from core, so the slot
 * identity is bound to core (a single resolved copy in every npm graph)
 * rather than to whichever fitness happens to be loaded first.
 *
 * Calling `getCheckConfig(...)` outside any `runWithScope` (e.g. unit
 * tests that don't set up a scope) returns an empty object — the
 * check's own defaults handle the empty case.
 */

import { currentScope } from '@opensip-tools/core'

import type { RecipeCheckConfigMap } from './types.js'
import type { RunScope } from '@opensip-tools/core'

/**
 * Read the per-check config slice for the given slug.
 *
 * Returns an empty object when no recipe-config has been set or no
 * entry exists for the slug — checks that call this should treat the
 * result as "augmentation only" and merge with their own defaults.
 * The stored entry is returned cast to `T` without runtime validation;
 * each check owns its own defaults and tolerates the empty case.
 *
 * @typeParam T - The shape the calling check expects. Each check declares
 *                its own config interface.
 */
export function getCheckConfig<T extends Record<string, unknown>>(slug: string): T {
  const scope = currentScope()
  const entry = scope?.recipeCheckConfig.get<T>(slug)
  if (!entry) return {} as T
  return entry
}

/**
 * Replace the current scope's recipe config. Called by the recipe
 * service at the start of a recipe run, before any check executes.
 *
 * Takes a scope explicitly rather than reading `currentScope()` so
 * that callers (like the recipe service's executeRecipe) make the
 * scope boundary explicit and lifecycle errors surface as type
 * errors rather than silently no-op'ing outside a scope.
 */
export function setCurrentRecipeCheckConfig(
  scope: RunScope,
  config: RecipeCheckConfigMap | undefined,
): void {
  scope.recipeCheckConfig.setAll(config ?? {})
}

/**
 * Clear the current scope's recipe config. Called by the recipe
 * service at the end of a recipe run (success or failure).
 */
export function clearCurrentRecipeCheckConfig(scope: RunScope): void {
  scope.recipeCheckConfig.clear()
}
