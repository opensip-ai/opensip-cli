/**
 * @fileoverview Per-check recipe configuration plumbing.
 *
 * These accessors are now thin aliases of the generic core accessors
 * (`getUnitConfig` / `setCurrentRecipeUnitConfig` /
 * `clearCurrentRecipeUnitConfig` in `@opensip-tools/core`); the fitness
 * names are preserved because checks import `getCheckConfig` from the
 * `@opensip-tools/fitness` barrel and the recipe service calls
 * `setCurrentRecipeCheckConfig` / `clearCurrentRecipeCheckConfig`.
 *
 * Recipes can carry a `checks.config` map keyed by check slug. The recipe
 * service projects this map into the current `RunScope`'s
 * `recipeUnitConfig` slot before any check runs and clears it once the
 * run completes. Individual checks read their slice via
 * `getCheckConfig<T>(slug)` and merge it with their built-in defaults.
 *
 * Scope-bound (not module-bound) lookup is load-bearing — the runtime
 * frequently has TWO copies of `@opensip-tools/fitness` loaded:
 *
 *   1. The CLI's bundled copy (running the recipe service).
 *   2. The plugin pack's resolved copy (running the check, calling
 *      `getCheckConfig(slug)`).
 *
 * Each copy has its own module-scope state. The lookup routes through
 * `currentScope()` from `@opensip-tools/core` (inside `getUnitConfig`) so
 * the slot identity is bound to core — a single resolved copy in every
 * npm graph — rather than to whichever fitness copy loaded first.
 *
 * Calling `getCheckConfig(...)` outside any `runWithScope` (e.g. unit
 * tests that don't set up a scope) returns an empty object — the check's
 * own defaults handle the empty case.
 */

import {
  getUnitConfig,
  setCurrentRecipeUnitConfig,
  clearCurrentRecipeUnitConfig,
} from '@opensip-tools/core'

import type { RecipeCheckConfigMap } from './types.js'
import type { RunScope } from '@opensip-tools/core'

/**
 * Read the per-check config slice for the given slug. Alias of core
 * `getUnitConfig`. Returns an empty object when no recipe-config has been
 * set or no entry exists — treat as "augmentation only" and merge with
 * the check's own defaults.
 *
 * @typeParam T - The shape the calling check expects.
 */
export function getCheckConfig<T extends Record<string, unknown>>(slug: string): T {
  return getUnitConfig<T>(slug)
}

/**
 * Replace the current scope's recipe config. Called by the recipe service
 * at the start of a recipe run, before any check executes. Alias of core
 * `setCurrentRecipeUnitConfig`.
 */
export function setCurrentRecipeCheckConfig(
  scope: RunScope,
  config: RecipeCheckConfigMap | undefined,
): void {
  setCurrentRecipeUnitConfig(scope, config)
}

/**
 * Clear the current scope's recipe config. Called by the recipe service
 * at the end of a recipe run (success or failure). Alias of core
 * `clearCurrentRecipeUnitConfig`.
 */
export function clearCurrentRecipeCheckConfig(scope: RunScope): void {
  clearCurrentRecipeUnitConfig(scope)
}
