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

import { ValidationError } from "@opensip-cli/core";

import type { SimulationRecipe, SimulationRecipeConfig } from "./types.js";

/**
 * Define a sim recipe. Validates the config and returns the canonical
 * `SimulationRecipe` value. Does NOT register the recipe — the plugin
 * loader registers via the explicit `recipes: [...]` array channel.
 *
 * @throws ValidationError if `id` or `name` is missing, or if the
 *   selector / execution shape is invalid.
 */
export function defineSimulationRecipe(
  config: SimulationRecipeConfig,
): SimulationRecipe {
  if (!config.id || typeof config.id !== "string") {
    throw new ValidationError("SimulationRecipe missing required `id`", {
      code: "VALIDATION.SIMULATION.RECIPE_ID_MISSING",
    });
  }
  if (!config.name || typeof config.name !== "string") {
    throw new ValidationError(
      `SimulationRecipe '${config.id}' missing required \`name\``,
      {
        code: "VALIDATION.SIMULATION.RECIPE_NAME_MISSING",
      },
    );
  }
  if (!config.scenarios || typeof config.scenarios !== "object") {
    throw new ValidationError(
      `SimulationRecipe '${config.name}' missing required \`scenarios\` selector`,
      { code: "VALIDATION.SIMULATION.RECIPE_SELECTOR_MISSING" },
    );
  }
  if (!config.execution || typeof config.execution !== "object") {
    throw new ValidationError(
      `SimulationRecipe '${config.name}' missing required \`execution\` block`,
      { code: "VALIDATION.SIMULATION.RECIPE_EXECUTION_MISSING" },
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

  if (exec.mode !== "parallel" && exec.mode !== "sequential") {
    throw new ValidationError(
      `SimulationRecipe '${config.name}' execution.mode must be 'parallel' or 'sequential'`,
      { code: "VALIDATION.SIMULATION.RECIPE_EXECUTION_INVALID_MODE" },
    );
  }

  if (
    exec.timeout !== undefined &&
    (!Number.isFinite(exec.timeout) || (exec.timeout as number) < 0)
  ) {
    throw new ValidationError(
      `SimulationRecipe '${config.name}' execution.timeout must be a non-negative finite number (or omitted)`,
      { code: "VALIDATION.SIMULATION.RECIPE_EXECUTION_INVALID_TIMEOUT" },
    );
  }

  if (
    exec.maxParallel !== undefined &&
    (!Number.isFinite(exec.maxParallel) || (exec.maxParallel as number) < 1)
  ) {
    throw new ValidationError(
      `SimulationRecipe '${config.name}' execution.maxParallel must be a positive finite integer (or omitted)`,
      { code: "VALIDATION.SIMULATION.RECIPE_EXECUTION_INVALID_MAX_PARALLEL" },
    );
  }

  if (
    exec.stopOnFirstFailure !== undefined &&
    typeof exec.stopOnFirstFailure !== "boolean"
  ) {
    throw new ValidationError(
      `SimulationRecipe '${config.name}' execution.stopOnFirstFailure must be a boolean (or omitted)`,
      {
        code: "VALIDATION.SIMULATION.RECIPE_EXECUTION_INVALID_STOP_ON_FIRST_FAILURE",
      },
    );
  }

  return config;
}
