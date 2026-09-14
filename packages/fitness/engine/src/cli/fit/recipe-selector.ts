/**
 * Recipe-pick + recipe-run helpers for the `fit` command.
 *
 * `selectRecipe()` decides between a named recipe (looked up in the
 * current scope's recipe registry) and an ad-hoc recipe constructed from
 * `--check` / `--tags`. `runRecipeOrAdHoc()` then executes the chosen
 * shape via `FitnessRecipeService`.
 */

import {
  BUILTIN_DEFAULT_RECIPE,
  EXIT_CODES,
  mapFailureToExitCode,
  resolveToolRecipeName,
} from '@opensip-cli/contracts';
import { createToolLogger, normalizeFailure, toPublicFailureProjection } from '@opensip-cli/core';

import { fitnessScopeError } from '../../errors/fitness-scope-error.js';
import { currentRecipeRegistry } from '../../framework/scope-registry.js';
import { FitnessRecipeService } from '../../recipes/service.js';

import { applyFitnessExecutionOverrides } from './resolved-fitness-config.js';

import type { FitnessExecutionOverrides } from './resolved-fitness-config.js';
import type { FitnessRecipe, FitnessRecipeResult } from '../../recipes/types.js';
import type { ErrorResult, FitOptions } from '@opensip-cli/contracts';

const log = createToolLogger('fitness:cli');

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
      log.warn({
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

/** Whether the project config imposes any execution knob on this run. */
function hasExecutionOverrides(overrides: FitnessExecutionOverrides | undefined): boolean {
  return overrides?.timeout !== undefined || overrides?.maxParallel !== undefined;
}

/**
 * Run the recipe (or ad-hoc selector built from `--check` / `--tags`).
 *
 * `executionOverrides` carries the project's `fitness.timeout` /
 * `fitness.maxParallel`. This is the point where the run's execution options are
 * finalized, so the override is applied to WHICHEVER recipe shape runs — named,
 * `--check`, or `--tags` — rather than only to the named-recipe branch.
 *
 * @throws {Error} When neither `args.check` nor `args.tags` is set but
 *   `recipeName` is `undefined` — an invariant violation in the caller
 *   (`selectRecipe` returns `recipeName` non-`undefined` in that branch).
 */
export async function runRecipeOrAdHoc(
  service: FitnessRecipeService,
  args: FitOptions,
  recipeName: string | undefined,
  executionOverrides?: FitnessExecutionOverrides,
): Promise<FitnessRecipeResult | { error: ErrorResult }> {
  const withOverrides = (recipe: FitnessRecipe): FitnessRecipe =>
    applyFitnessExecutionOverrides(recipe, executionOverrides);
  try {
    if (args.check) {
      return await service.start(
        withOverrides(FitnessRecipeService.createAdHocRecipe({ check: args.check })),
      );
    }
    const tagFilters = tagFiltersFrom(args.tags);
    if (tagFilters.length > 0) {
      return await service.start(
        withOverrides(FitnessRecipeService.createAdHocRecipe({ tagFilters })),
      );
    }
    // selectRecipe sets recipeName to undefined only when args.check or
    // args.tags are present — both of which return earlier in this function.
    // Guard explicitly so the type system tracks the narrowing without `!`.
    if (recipeName == null) {
      throw fitnessScopeError(
        'recipe-selection-invariant',
        'runRecipeOrAdHoc: recipeName must be defined when args.check/args.tags are absent',
      );
    }
    // Without config overrides the name goes straight to `start`, exactly as
    // before — no pre-resolution, so the registry lookup + NotFoundError stay
    // wholly owned by the service. Only when the project actually imposes a
    // knob do we resolve the recipe here to fold it in; a name the registry does
    // not know is still forwarded AS THE NAME so `start` raises its own
    // NotFoundError and the established failure path is unchanged.
    if (!hasExecutionOverrides(executionOverrides)) {
      return await service.start(recipeName);
    }
    const named = service.getRecipe(recipeName);
    return await service.start(named === undefined ? recipeName : withOverrides(named));
  } catch (error) {
    const projectedMessage = toPublicFailureProjection(normalizeFailure(error)).message;
    const message =
      typeof projectedMessage === 'string' ? projectedMessage : 'The fitness run failed.';
    const exitCode = mapFailureToExitCode(error);
    return {
      error: {
        type: 'error',
        message: exitCode === EXIT_CODES.RUNTIME_ERROR ? `Fitness run failed: ${message}` : message,
        exitCode,
      },
    };
  }
}
