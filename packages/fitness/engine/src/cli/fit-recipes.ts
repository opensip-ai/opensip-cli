/**
 * fit-recipes command — list all available fitness recipes
 */

import { currentRecipeRegistry } from '../framework/scope-registry.js';

import { ensureChecksLoaded } from './fit.js';

import type { ListRecipesResult } from '@opensip-cli/contracts';

// ---------------------------------------------------------------------------
// listRecipes
// ---------------------------------------------------------------------------

/** Returns metadata for every registered recipe (built-in plus user-defined). */
export async function listRecipes(projectDir?: string): Promise<ListRecipesResult> {
  // Load plugins so user-defined recipes (e.g. ~/.opensip-cli/fit/*.mjs) appear.
  await ensureChecksLoaded(projectDir);

  const recipes = currentRecipeRegistry()
    .getAllRecipes()
    .map((recipe) => {
      const selector = recipe.checks;
      let checkCount: string;
      if (selector.type === 'all') {
        checkCount = 'all checks';
      } else if (selector.type === 'explicit') {
        checkCount = `${selector.checkIds.length} checks`;
      } else {
        checkCount = 'pattern-based';
      }
      return { name: recipe.name, description: recipe.description, checkCount };
    });

  return {
    type: 'list-recipes',
    recipes,
  };
}
