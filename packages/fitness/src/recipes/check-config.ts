/**
 * @fileoverview Per-check recipe configuration plumbing.
 *
 * Recipes can carry a `checks.config` map keyed by check slug. The recipe
 * service projects this map into module-level state before any check runs
 * (`setCurrentRecipeCheckConfig`) and clears it once the run completes
 * (`clearCurrentRecipeCheckConfig`).
 *
 * Individual checks read their slice via `getCheckConfig<T>(slug)` —
 * typically once at module load (when imported by the registry) or at the
 * top of `analyze` — and merge it with their built-in defaults.
 *
 * This is the seam that lets us keep `@opensip-tools/checks-builtin`'s
 * defaults to *generic* conventions (Node stdlib, well-known SDKs, common
 * filename patterns) while letting downstream projects (like opensip)
 * extend the safe-lists with project-specific names.
 */

import type { RecipeCheckConfigMap } from './types.js'

/**
 * Module-scoped current-recipe config. Populated by the recipe service at
 * the start of a run and cleared at the end. Checks read from it lazily via
 * {@link getCheckConfig}.
 *
 * Module-level singleton is acceptable here because a recipe service runs
 * one session at a time (the service throws SESSION_IN_PROGRESS otherwise).
 * If we ever support concurrent recipe runs in the same process, this needs
 * to move into AsyncLocalStorage.
 */
let currentRecipeCheckConfig: RecipeCheckConfigMap | undefined

/**
 * Read the per-check config slice for the given slug.
 *
 * Returns an empty object when no recipe-config has been set or no entry
 * exists for the slug — checks that call this should treat the result as
 * "augmentation only" and merge with their own defaults.
 *
 * @typeParam T - The shape the calling check expects. Each check declares
 *                its own config interface.
 */
export function getCheckConfig<T extends Record<string, unknown>>(slug: string): T {
  if (!currentRecipeCheckConfig) return {} as T
  const entry = currentRecipeCheckConfig[slug]
  if (!entry) return {} as T
  return entry as T
}

/**
 * Replace the module-level recipe config. Called by the recipe service at
 * the start of a recipe run, before any check executes.
 */
export function setCurrentRecipeCheckConfig(config: RecipeCheckConfigMap | undefined): void {
  currentRecipeCheckConfig = config
}

/**
 * Clear the module-level recipe config. Called by the recipe service at
 * the end of a recipe run (success or failure).
 */
export function clearCurrentRecipeCheckConfig(): void {
  currentRecipeCheckConfig = undefined
}
