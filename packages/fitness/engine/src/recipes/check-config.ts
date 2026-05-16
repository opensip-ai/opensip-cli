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
 * Process-shared current-recipe config. Populated by the recipe service at
 * the start of a run and cleared at the end. Checks read from it lazily via
 * {@link getCheckConfig}.
 *
 * `globalThis` (not module-local `let`) is load-bearing — the runtime
 * frequently has TWO copies of `@opensip-tools/fitness` loaded:
 *
 *   1. The CLI's bundled copy (running the recipe service).
 *   2. The plugin pack's resolved copy (running the check, calling
 *      `getCheckConfig(slug)`).
 *
 * Each copy has its own module-scope state, so a module-local `let` here
 * means `setCurrentRecipeCheckConfig(...)` in copy 1 is invisible to
 * `getCheckConfig(...)` in copy 2 — the recipe's `additionalSyncFunctions`
 * (and every other per-check allowlist) silently never reaches the checks
 * that read it. Storing the map on `globalThis` under a single well-known
 * symbol means every copy reads + writes the same slot.
 *
 * The single-session contract still holds (the recipe service throws
 * SESSION_IN_PROGRESS otherwise); the only thing that changes vs the prior
 * design is the storage location, not the lifecycle.
 */
const GLOBAL_KEY = Symbol.for('@opensip-tools/fitness/currentRecipeCheckConfig')

interface GlobalSlot {
  [GLOBAL_KEY]?: RecipeCheckConfigMap | undefined
}

function slot(): GlobalSlot {
  return globalThis as unknown as GlobalSlot
}

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
  const current = slot()[GLOBAL_KEY]
  if (!current) return {} as T
  const entry = current[slug]
  if (!entry) return {} as T
  return entry as T
}

/**
 * Replace the global recipe config. Called by the recipe service at
 * the start of a recipe run, before any check executes.
 */
export function setCurrentRecipeCheckConfig(config: RecipeCheckConfigMap | undefined): void {
  slot()[GLOBAL_KEY] = config
}

/**
 * Clear the global recipe config. Called by the recipe service at the end
 * of a recipe run (success or failure).
 */
export function clearCurrentRecipeCheckConfig(): void {
  slot()[GLOBAL_KEY] = undefined
}
