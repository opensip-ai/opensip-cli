/**
 * Recipe-pick + recipe-run helpers for the `fit` command.
 *
 * `selectRecipe()` decides between a named recipe (looked up in the
 * current scope's recipe registry) and an ad-hoc recipe constructed from
 * `--check` / `--tags`. `runRecipeOrAdHoc()` then executes the chosen
 * shape via `FitnessRecipeService`.
 */

import { BUILTIN_DEFAULT_RECIPE, EXIT_CODES, resolveToolRecipeName } from '@opensip-tools/contracts';
import { logger } from '@opensip-tools/core';

import { currentRecipeRegistry } from '../../framework/scope-registry.js';
import { FitnessRecipeService } from '../../recipes/service.js';

import type { FitnessRecipeResult } from '../../recipes/types.js';
import type { ErrorResult, FitOptions } from '@opensip-tools/contracts';

/**
 * Tool-scoped recipe defaults for `fit` (ADR-0022), read from the project
 * config by the caller: `toolRecipe` is `fitness.recipe`, `cliRecipe` is the
 * deprecated cross-tool `cli.recipe` fallback.
 */
export interface FitRecipeDefaults {
  readonly toolRecipe?: string;
  readonly cliRecipe?: string;
}

/**
 * Decide which recipe to execute. `--check` and `--tags` each create an
 * ad-hoc recipe (recipeName=undefined); otherwise resolve a named recipe with
 * tool-scoped precedence (ADR-0022): `--recipe` flag > `fitness.recipe` >
 * deprecated `cli.recipe` > built-in `default`. A config-sourced unknown name
 * tolerantly falls back to `default` with a warning (the default may belong to
 * another tool); an explicit `--recipe` typo returns an `ErrorResult`.
 *
 * **Precondition:** must run *after* `ensureChecksLoaded` so that any
 * user-defined recipes (loaded as `.mjs` plugins under
 * `<cwd>/opensip-tools/fit/recipes/`) are present in the scope's recipe
 * registry by the time the lookup runs. Inverting the two
 * lines silently breaks recipe lookup for plugin-provided recipes.
 */
export function selectRecipe(
  args: FitOptions,
  defaults: FitRecipeDefaults = {},
): { recipeName: string | undefined } | { error: ErrorResult } {
  const useAdHoc = args.check != null || args.tags != null;
  if (useAdHoc) return { recipeName: undefined };

  const resolved = resolveToolRecipeName({
    explicit: args.recipe,
    toolRecipe: defaults.toolRecipe,
    cliRecipe: defaults.cliRecipe,
  });
  if (resolved.usedDeprecatedCliRecipe) {
    logger.warn({
      evt: 'fit.recipe.cli_recipe_deprecated',
      module: 'cli:fit',
      recipe: resolved.name,
      msg: `cli.recipe is deprecated (ADR-0022); set fitness.recipe instead. Using '${resolved.name}' as a fallback for fit.`,
    });
  }

  if (!currentRecipeRegistry().has(resolved.name)) {
    // Config-sourced unknown name → fall back to the built-in default rather
    // than abort (it may be a shared/cross-tool default targeting another tool).
    if (resolved.tolerant && resolved.name !== BUILTIN_DEFAULT_RECIPE) {
      logger.warn({
        evt: 'fit.recipe.unknown_config_default',
        module: 'cli:fit',
        requested: resolved.name,
        fallback: BUILTIN_DEFAULT_RECIPE,
        msg: `Configured fit recipe '${resolved.name}' not found; using '${BUILTIN_DEFAULT_RECIPE}'. If '${resolved.name}' is a recipe for another tool, move it under that tool's <tool>.recipe key (ADR-0022).`,
      });
      return { recipeName: BUILTIN_DEFAULT_RECIPE };
    }
    // Explicit --recipe typo → hard error (unchanged typo protection).
    return {
      error: {
        type: 'error',
        message: `Unknown recipe '${resolved.name}'.`,
        suggestion: 'Run opensip-tools fit --recipes to see available recipes.',
        exitCode: EXIT_CODES.CONFIGURATION_ERROR,
      },
    };
  }
  return { recipeName: resolved.name };
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
