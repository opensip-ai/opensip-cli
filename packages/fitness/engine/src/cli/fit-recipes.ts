/**
 * fit-recipes command — list all available fitness recipes
 */

import {
  allUnitsLabel,
  explicitUnitsLabel,
  PATTERN_BASED_LABEL,
  recipeDisplayInfo,
} from '@opensip-cli/core';

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
      let selectionLabel: string;
      if (selector.type === 'all') {
        selectionLabel = allUnitsLabel('checks');
      } else if (selector.type === 'explicit') {
        selectionLabel = explicitUnitsLabel(selector.checkIds.length, 'check', 'checks');
      } else {
        selectionLabel = PATTERN_BASED_LABEL;
      }
      const display = recipeDisplayInfo(recipe, selectionLabel);
      return {
        name: display.name,
        description: display.description,
        checkCount: display.selectionLabel,
        selectionLabel: display.selectionLabel,
      };
    });

  return {
    type: 'list-recipes',
    recipes,
  };
}
