/**
 * @fileoverview Shared recipe-registration helper for fitness + simulation
 * plugin loaders. Single implementation of the "iterate mod.recipes,
 * shape-check each, register, count" pattern that previously appeared in
 * three near-identical sites (fitness/engine/src/plugins/loader.ts,
 * fitness/engine/src/cli/fit.ts, simulation/engine/src/cli/sim.ts).
 *
 * The malformed-recipe warning preserves the careful pattern from
 * loader.ts — recipes that fail the `id + name` shape check emit a
 * `plugin.recipe.invalid_item` warning so the customer can see what
 * was skipped.
 *
 * Duplicate handling: the underlying `RecipeRegistry.register` doesn't
 * throw on duplicate when `allowOverwrite: false` (the default) — it
 * logs a `recipe.registry.duplicate` warning and silently returns.
 * This helper uses `registry.has()` to check first, so `recipesRegistered`
 * counts only entries that genuinely landed in the registry. The
 * optional `onDuplicate` callback lets the caller observe the rejection
 * (no-op by default).
 *
 * No try/catch around `register` itself — if the registry throws for
 * an unexpected reason (validation error, internal failure), the error
 * propagates to the caller's outer try/catch in cli/fit.ts or cli/sim.ts,
 * surfacing as a per-package load failure rather than being silently
 * misattributed as a duplicate.
 */

import type { RecipeBase, RecipeRegistry } from '../recipes/registry.js';

export interface RegisterRecipesOptions<R extends RecipeBase> {
  /** Package name (or plugin namespace) used in warning messages. */
  readonly namespace: string;
  /**
   * Warn callback. Adapts to loader.ts's `ctx.warn(evt, message, extra)`
   * channel and the CLI sites' `logger.warn(...)` shape.
   */
  readonly onWarn: (evt: string, message: string, extra?: Record<string, unknown>) => void;
  /**
   * Invoked when a recipe is skipped because the registry already has
   * one with the same id/name. Defaults to a no-op. Useful for tests
   * and for callers that want a structured count of duplicates.
   */
  readonly onDuplicate?: (recipe: R) => void;
}

export interface RegisterRecipesResult {
  /** Count of recipes that actually entered the registry. */
  readonly recipesRegistered: number;
}

/**
 * Iterate `mod.recipes` (if present), shape-check each item, and
 * register valid entries into the registry. Returns the count of
 * successful registrations.
 *
 * - `mod.recipes` undefined or not an array → returns `{ recipesRegistered: 0 }`.
 * - Item fails the shape check (`'id' in recipe && 'name' in recipe`) →
 *   emits `plugin.recipe.invalid_item` via `onWarn` and skips.
 * - Item is a duplicate of an existing entry (by id or name) → skipped
 *   without incrementing; `onDuplicate` invoked if provided. The
 *   registry's own warning surfaces the duplicate event.
 * - Registry throws on `register` for any other reason → propagates.
 */
export function registerRecipesFromMod<R extends RecipeBase>(
  mod: unknown,
  registry: RecipeRegistry<R>,
  options: RegisterRecipesOptions<R>,
): RegisterRecipesResult {
  const recipes = (mod as { recipes?: unknown } | null | undefined)?.recipes;
  if (!Array.isArray(recipes)) {
    return { recipesRegistered: 0 };
  }
  let recipesRegistered = 0;
  for (const [index, item] of recipes.entries()) {
    if (!isShapedLikeRecipe(item)) {
      options.onWarn(
        'plugin.recipe.invalid_item',
        `${options.namespace} recipes[${index}] is not a valid Recipe object (missing id or name) — skipping.`,
        { index },
      );
      continue;
    }
    const recipe = item as R;
    if (registry.has(recipe.id) || registry.has(recipe.name)) {
      options.onDuplicate?.(recipe);
      continue;
    }
    registry.register(recipe, { allowOverwrite: false });
    recipesRegistered++;
  }
  return { recipesRegistered };
}

function isShapedLikeRecipe(
  value: unknown,
): value is { readonly id: string; readonly name: string } {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.id === 'string' && typeof obj.name === 'string';
}
