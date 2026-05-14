/**
 * @fileoverview `defineSimulationRecipe()` — author-facing factory.
 *
 * Mirrors fitness's `defineCheck` pattern. Returns a validated
 * SimulationRecipe and registers it with the default registry as a
 * side effect, so user-authored recipes in `opensip-tools/sim/recipes/`
 * are discovered by the loader.
 */

import { ValidationError } from '@opensip-tools/core';

import { defaultSimulationRecipeRegistry } from './registry.js';

import type { SimulationRecipe, SimulationRecipeConfig } from './types.js';

/**
 * Define a sim recipe. Validates the config, registers it with the
 * shared default registry, and returns the canonical
 * `SimulationRecipe` value.
 *
 * @throws ValidationError if `id` or `name` is missing, or if the
 *   selector shape is invalid.
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
  // The factory is the registration point. Tests that need isolation
  // call defaultSimulationRecipeRegistry.clear() in afterEach.
  defaultSimulationRecipeRegistry.register(config);
  return config;
}
