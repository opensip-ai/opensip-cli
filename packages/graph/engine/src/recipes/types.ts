/**
 * @fileoverview Graph recipe types + `defineGraphRecipe`.
 *
 * Instantiates Plan A's generic core recipe substrate over `T = Rule`. A
 * `GraphRecipe` selects a named subset of registered graph rules plus
 * metadata — selection only. Graph's "execution" is just the existing
 * rule loop (evaluate every selected rule once over the dataset); there
 * is no parallel/sequential scheduler, no retry, no reporting format, so
 * `GraphRecipe` carries **no** `execution`/`reporting` blocks (unlike
 * `FitnessRecipe`). This is the spec's execution/selection seam: selection
 * is shared (Plan A), execution stays tool-owned.
 *
 * **Selection vocabulary (Plan B decision).** Graph rules have a slug (id)
 * but **no tags today** — adding `tags` to `Rule` would touch the
 * fingerprint surface, which Plan B keeps byte-stable. So graph recipes use
 * only the `explicit` + `all` selector arms in Plan B. `RuleSelector` is the
 * full core union (the `tags`/`pattern` arms are simply unused here);
 * narrowing the type would force a cast at the `resolveSelector` boundary
 * for no benefit. Tag-based graph selection is deferred (spec Open Question
 * "selection vocabulary").
 */

import type { RecipeSelector, RecipeUnitConfigMap } from '@opensip-cli/core';

/**
 * The selector union a graph recipe uses to pick rules. Aliased from core's
 * generic `RecipeSelector` over the per-unit config map. Plan B exercises
 * only the `explicit` (by rule slug) and `all` arms.
 */
export type RuleSelector = RecipeSelector;

/** Re-exported for recipe authors that attach per-rule config (forward-compat). */
export type RuleConfigMap = RecipeUnitConfigMap;

/**
 * A graph recipe: a named, selectable subset of graph rules. Satisfies
 * core's `RecipeBase` so it can live in a `RecipeRegistry<GraphRecipe>`.
 */
export interface GraphRecipe {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly rules: RuleSelector;
  readonly tags?: readonly string[];
}

/** Author-facing input for {@link defineGraphRecipe}. */
export interface GraphRecipeDefinition {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly rules: RuleSelector;
  readonly tags?: readonly string[];
}

/**
 * Build a frozen {@link GraphRecipe} from a definition. Derives
 * `id = 'GRCP_' + name`. No execution defaults to apply (graph has no
 * execution block). No import side effects — the caller registers the
 * returned value explicitly.
 */
export function defineGraphRecipe(def: GraphRecipeDefinition): GraphRecipe {
  const recipe: GraphRecipe = {
    id: `GRCP_${def.name}`,
    name: def.name,
    displayName: def.displayName,
    description: def.description,
    rules: def.rules,
    ...(def.tags ? { tags: def.tags } : {}),
  };
  return Object.freeze(recipe);
}
