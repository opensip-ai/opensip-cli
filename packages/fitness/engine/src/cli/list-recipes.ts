/**
 * list-recipes command — list all available fitness recipes
 */


import { defaultRecipeRegistry } from '../recipes/registry.js';

import { ensureChecksLoaded } from './fit.js';

import type { ListRecipesResult } from '@opensip-tools/contracts';

// ---------------------------------------------------------------------------
// listRecipes
// ---------------------------------------------------------------------------

export async function listRecipes(projectDir?: string): Promise<ListRecipesResult> {
  // Load plugins so user-defined recipes (e.g. ~/.opensip-tools/fit/*.mjs) appear.
  await ensureChecksLoaded(projectDir);

  const recipes = defaultRecipeRegistry.getAllRecipes().map((recipe) => {
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

