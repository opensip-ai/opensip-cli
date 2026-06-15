/**
 * Recipe-pick + recipe-run helpers for the `fit` command.
 *
 * `selectRecipe()` decides between a named recipe (looked up in the
 * current scope's recipe registry) and an ad-hoc recipe constructed from
 * `--check` / `--tags`. `runRecipeOrAdHoc()` then executes the chosen
 * shape via `FitnessRecipeService`.
 */

import { BUILTIN_DEFAULT_RECIPE, EXIT_CODES, resolveToolRecipeName } from '@opensip-cli/contracts';
import { ConfigurationError, logger } from '@opensip-cli/core';

import { currentRecipeRegistry } from '../../framework/scope-registry.js';
import { FitnessRecipeService } from '../../recipes/service.js';

import type { FitnessRecipeResult } from '../../recipes/types.js';
import type { ErrorResult, FitOptions } from '@opensip-cli/contracts';

/**
 * Tool-scoped recipe defaults for `fit` (ADR-0022), read from the project
 * config by the caller: `toolRecipe` is `fitness.recipe`.
 */
export interface FitRecipeDefaults {
  readonly toolRecipe?: string;
}

/**
 * Flatten the (repeatable, possibly comma-separated) `--tags` values into a
 * trimmed, non-empty tag-filter list. `--tags a,b --tags c` → `['a','b','c']`.
 */
export function tagFiltersFrom(tags: readonly string[] | undefined): string[] {
  return (tags ?? [])
    .flatMap((t) => t.split(','))
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Decide which recipe to execute. `--check` and `--tags` each create an
 * ad-hoc recipe (recipeName=undefined); otherwise resolve a named recipe with
 * tool-scoped precedence (ADR-0022): `--recipe` flag > `fitness.recipe` >
 * built-in `default`. A config-sourced unknown name tolerantly falls back to
 * `default` with a warning (the default may belong to another tool); an explicit
 * `--recipe` typo returns an `ErrorResult`.
 *
 * **Precondition:** must run *after* `ensureChecksLoaded` so that any
 * user-defined recipes (loaded as `.mjs` plugins under
 * `<cwd>/opensip-cli/fit/recipes/`) are present in the scope's recipe
 * registry by the time the lookup runs. Inverting the two
 * lines silently breaks recipe lookup for plugin-provided recipes.
 */
export function selectRecipe(
  args: FitOptions,
  defaults: FitRecipeDefaults = {},
): { recipeName: string | undefined } | { error: ErrorResult } {
  const useAdHoc = args.check != null || tagFiltersFrom(args.tags).length > 0;
  if (useAdHoc) return { recipeName: undefined };

  const resolved = resolveToolRecipeName({
    explicit: args.recipe,
    toolRecipe: defaults.toolRecipe,
  });

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
        suggestion: 'Run opensip fit --recipes to see available recipes.',
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
    const tagFilters = tagFiltersFrom(args.tags);
    if (tagFilters.length > 0) {
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
    const isConfigurationError = error instanceof ConfigurationError;
    return {
      error: {
        type: 'error',
        message: isConfigurationError ? msg : `Fitness run failed: ${msg}`,
        exitCode: isConfigurationError ? EXIT_CODES.CONFIGURATION_ERROR : EXIT_CODES.RUNTIME_ERROR,
      },
    };
  }
}
