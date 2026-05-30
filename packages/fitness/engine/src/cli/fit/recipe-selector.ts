/**
 * Recipe-pick + recipe-run helpers for the `fit` command.
 *
 * `selectRecipe()` decides between a named recipe (looked up in
 * `defaultRecipeRegistry`) and an ad-hoc recipe constructed from
 * `--check` / `--tags`. `runRecipeOrAdHoc()` then executes the chosen
 * shape via `FitnessRecipeService`.
 */

import { EXIT_CODES } from '@opensip-tools/contracts';

import { defaultRecipeRegistry } from '../../recipes/registry.js';
import { FitnessRecipeService } from '../../recipes/service.js';

import type { FitnessRecipeResult } from '../../recipes/types.js';
import type { ErrorResult, FitOptions } from '@opensip-tools/contracts';

/**
 * Decide which recipe to execute. `--check` and `--tags` each create an
 * ad-hoc recipe (recipeName=undefined); otherwise look up a named
 * recipe. Returns either the resolved name or `undefined` (ad-hoc), or
 * an `ErrorResult` when the requested name doesn't exist.
 *
 * **Precondition:** must run *after* `ensureChecksLoaded` so that any
 * user-defined recipes (loaded as `.mjs` plugins under
 * `<cwd>/opensip-tools/fit/recipes/`) are present in
 * `defaultRecipeRegistry` by the time the lookup runs. Inverting the two
 * lines silently breaks recipe lookup for plugin-provided recipes.
 */
export function selectRecipe(
  args: FitOptions,
): { recipeName: string | undefined } | { error: ErrorResult } {
  const useAdHoc = args.check != null || args.tags != null;
  const recipeName = useAdHoc ? undefined : (args.recipe ?? 'default');
  if (recipeName && !defaultRecipeRegistry.has(recipeName)) {
    return {
      error: {
        type: 'error',
        message: `Unknown recipe '${recipeName}'.`,
        suggestion: 'Run opensip-tools fit --recipes to see available recipes.',
        exitCode: EXIT_CODES.CONFIGURATION_ERROR,
      },
    };
  }
  return { recipeName };
}

/**
 * Run the recipe (or ad-hoc selector built from `--check` / `--tags`).
 *
 * @throws {Error} When neither `args.check` nor `args.tags` is set but
 *   `recipeName` is `undefined` — an invariant violation in the caller
 *   (`selectRecipe` returns `recipeName` non-`undefined` in that branch).
 */
export async function runRecipeOrAdHoc(
  service: FitnessRecipeService,
  args: FitOptions,
  recipeName: string | undefined,
): Promise<FitnessRecipeResult | { error: ErrorResult }> {
  try {
    if (args.check) {
      return await service.start(FitnessRecipeService.createAdHocRecipe({ check: args.check }));
    }
    if (args.tags) {
      const tagFilters = args.tags.split(',').map(t => t.trim()).filter(Boolean);
      return await service.start(FitnessRecipeService.createAdHocRecipe({ tagFilters }));
    }
    // selectRecipe sets recipeName to undefined only when args.check or
    // args.tags are present — both of which return earlier in this function.
    // Guard explicitly so the type system tracks the narrowing without `!`.
    if (recipeName == null) {
      throw new Error(
        'runRecipeOrAdHoc: recipeName must be defined when args.check/args.tags are absent',
      );
    }
    return await service.start(recipeName);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      error: {
        type: 'error',
        message: `Fitness run failed: ${msg}`,
        exitCode: EXIT_CODES.RUNTIME_ERROR,
      },
    };
  }
}
