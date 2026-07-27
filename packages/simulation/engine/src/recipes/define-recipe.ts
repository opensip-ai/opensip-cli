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

import { ValidationError } from '@opensip-cli/core';

import { simulationErrorCatalog } from '../errors/simulation-error-catalog.js';

/**
 * One clustered definition for every recipe-authoring rejection (ruling D9).
 *
 * These were eight distinct `VALIDATION.SIMULATION.*` string literals with no catalog entry,
 * alive only through `legacyFamilyCode`'s head-guessing. A recipe author fixes all of them the
 * same way in the same file, so the code is one and the offending field travels in metadata.
 */
const RECIPE_INVALID = simulationErrorCatalog.require('SIMULATION.RECIPE.INVALID');

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
      code: RECIPE_INVALID.code,
      definition: RECIPE_INVALID,
      metadata: { field: 'id', condition: 'missing' },
    });
  }
  if (!config.name || typeof config.name !== 'string') {
    throw new ValidationError(`SimulationRecipe '${config.id}' missing required \`name\``, {
      code: RECIPE_INVALID.code,
      definition: RECIPE_INVALID,
      metadata: { field: 'name', condition: 'missing' },
    });
  }
  if (!config.scenarios || typeof config.scenarios !== 'object') {
    throw new ValidationError(
      `SimulationRecipe '${config.name}' missing required \`scenarios\` selector`,
      {
        code: RECIPE_INVALID.code,
        definition: RECIPE_INVALID,
        metadata: { field: 'scenarios', condition: 'missing' },
      },
    );
  }
  if (!config.execution || typeof config.execution !== 'object') {
    throw new ValidationError(
      `SimulationRecipe '${config.name}' missing required \`execution\` block`,
      {
        code: RECIPE_INVALID.code,
        definition: RECIPE_INVALID,
        metadata: { field: 'execution', condition: 'missing' },
      },
    );
  }

  // Stronger validation for execution semantics (audit fix). Previously only
  // checked "is object", allowing JS-authored recipes (and therefore plugin
  // recipes) to pass garbage that scheduleUnits would misinterpret (unknown
  // mode -> treated as parallel, NaN/negative concurrency or timeout, etc.).
  const exec = config.execution as {
    mode?: unknown;
    timeout?: unknown;
    maxParallel?: unknown;
    stopOnFirstFailure?: unknown;
  };

  if (exec.mode !== 'parallel' && exec.mode !== 'sequential') {
    throw new ValidationError(
      `SimulationRecipe '${config.name}' execution.mode must be 'parallel' or 'sequential'`,
      {
        code: RECIPE_INVALID.code,
        definition: RECIPE_INVALID,
        metadata: { field: 'execution.mode', condition: 'invalid' },
      },
    );
  }

  if (
    exec.timeout !== undefined &&
    (!Number.isFinite(exec.timeout) || (exec.timeout as number) <= 0)
  ) {
    // A `timeout` of 0 is rejected rather than reinterpreted as "unlimited" —
    // it would otherwise reach `runWithTimeout` as `setTimeout(fn, 0)`, which
    // aborts the scenario before it ever gets to run. "Omit the field" is the
    // documented way to request no timeout (see NO_TIMEOUT_MS in service.ts).
    throw new ValidationError(
      `SimulationRecipe '${config.name}' execution.timeout must be a positive finite number (or omitted for no timeout)`,
      {
        code: RECIPE_INVALID.code,
        definition: RECIPE_INVALID,
        metadata: { field: 'execution.timeout', condition: 'invalid' },
      },
    );
  }

  if (
    exec.maxParallel !== undefined &&
    (!Number.isFinite(exec.maxParallel) || (exec.maxParallel as number) < 1)
  ) {
    throw new ValidationError(
      `SimulationRecipe '${config.name}' execution.maxParallel must be a positive finite integer (or omitted)`,
      {
        code: RECIPE_INVALID.code,
        definition: RECIPE_INVALID,
        metadata: { field: 'execution.maxParallel', condition: 'invalid' },
      },
    );
  }

  if (exec.stopOnFirstFailure !== undefined && typeof exec.stopOnFirstFailure !== 'boolean') {
    throw new ValidationError(
      `SimulationRecipe '${config.name}' execution.stopOnFirstFailure must be a boolean (or omitted)`,
      {
        code: RECIPE_INVALID.code,
        definition: RECIPE_INVALID,
        metadata: { field: 'execution.stopOnFirstFailure', condition: 'invalid' },
      },
    );
  }

  return config;
}
