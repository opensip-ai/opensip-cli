/**
 * @fileoverview `defineSimulationRecipe()` — author-facing factory.
 *
 * Returns a validated `SimulationRecipe` value. Registration is the
 * plugin loader's responsibility — `defineSimulationRecipe` does NOT
 * register the recipe as a side effect (mirrors what `defineXScenario`
 * did in commit 1a0a71b; Item 1 closes the symmetry now that the
 * simulation recipe registry is per-RunScope).
 *
 * User code authors recipes by exporting an array:
 *
 *   export const recipes = [
 *     defineSimulationRecipe({ id: 'URCP_my', name: 'my', ... }),
 *   ];
 *
 * The plugin loader's `registerRecipesArray` iterates `recipes` and
 * registers each into the current scope's `SimulationRecipeRegistry`.
 */

import { ValidationError } from '@opensip-tools/core';

import type { SimulationRecipe, SimulationRecipeConfig } from './types.js';

/**
 * Define a sim recipe. Validates the config and returns the canonical
 * `SimulationRecipe` value. Does NOT register the recipe — the plugin
 * loader registers via the explicit `recipes: [...]` array channel.
 *
 * @throws ValidationError if `id` or `name` is missing, or if the
 *   selector / execution shape is invalid.
 */
export function defineSimulationRecipe(config: SimulationRecipeConfig): SimulationRecipe {
  if (!config.id || typeof config.id !== 'string') {
    throw new ValidationError('SimulationRecipe missing required `id`', {
      code: 'VALIDATION.SIMULATION.RECIPE_ID_MISSING',
    });
  }
  if (!config.name || typeof config.name !== 'string') {
    throw new ValidationError(`SimulationRecipe '${config.id}' missing required \`name\``, {
      code: 'VALIDATION.SIMULATION.RECIPE_NAME_MISSING',
    });
  }
  if (!config.scenarios || typeof config.scenarios !== 'object') {
    throw new ValidationError(
      `SimulationRecipe '${config.name}' missing required \`scenarios\` selector`,
      { code: 'VALIDATION.SIMULATION.RECIPE_SELECTOR_MISSING' },
    );
  }
  if (!config.execution || typeof config.execution !== 'object') {
    throw new ValidationError(
      `SimulationRecipe '${config.name}' missing required \`execution\` block`,
      { code: 'VALIDATION.SIMULATION.RECIPE_EXECUTION_MISSING' },
    );
  }
  return config;
}
