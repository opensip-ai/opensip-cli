/**
 * graph-recipes command — list all available graph recipes.
 *
 * Mirrors fitness's `listRecipes` (`cli/fit-recipes.ts`): maps the
 * scope-bound recipe registry to the shared `ListRecipesResult` contract so
 * the existing CLI renderer (`viewListRecipes`) handles the output with no
 * contracts change. `checkCount` is a free-form label; graph reuses it as a
 * rule count ("all rules" / "N rules").
 *
 * Reads `currentGraphRecipes()`, so it runs inside the entered RunScope (the
 * command action body does).
 */

import { currentGraphRecipes } from '../recipes/registry.js';

import type { ListRecipesResult } from '@opensip-tools/contracts';

/**
 * Returns metadata for every registered graph recipe.
 *
 * Returns a `Promise` to mirror fitness's `listRecipes` signature (which is
 * genuinely async — it loads user plugins first). Graph has no async
 * pre-step today; the registry is scope-seeded at construction, so this
 * resolves synchronously.
 */
export function listGraphRecipes(): Promise<ListRecipesResult> {
  const recipes = currentGraphRecipes()
    .getAllRecipes()
    .map((recipe) => {
      const selector = recipe.rules;
      let checkCount: string;
      if (selector.type === 'all') {
        checkCount = 'all rules';
      } else if (selector.type === 'explicit') {
        checkCount = `${selector.ids.length} rules`;
      } else {
        checkCount = 'pattern-based';
      }
      return { name: recipe.name, description: recipe.description, checkCount };
    });

  return Promise.resolve({
    type: 'list-recipes',
    recipes,
  });
}
