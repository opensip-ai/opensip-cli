/**
 * @fileoverview Ad-hoc recipe factory for CLI-driven fitness runs
 *
 * Converts CLI arguments into a {@link FitnessRecipe} for one-off check execution.
 */

import { DEFAULT_MAX_PARALLEL, type CheckSelector, type FitnessRecipe } from './types.js';

/** CLI arguments for building an ad-hoc fitness recipe. */
export interface AdHocRecipeArgs {
  check?: string;
  tagFilters?: string[];
  file?: string;
  parallel?: boolean;
  json?: boolean;
  unified?: boolean;
  verbose?: boolean;
  retry?: boolean;
  maxRetries?: number;
  maxParallel?: number;
  timeout?: number;
  successThreshold?: number;
}

/** Convert CLI arguments to an ad-hoc {@link FitnessRecipe}. */
export function createAdHocRecipe(args: AdHocRecipeArgs): FitnessRecipe {
  let checks: CheckSelector;
  let includeDisabled: string[] | undefined;

  if (args.check) {
    if (args.check.includes('*') || args.check.includes('?')) {
      checks = { type: 'pattern', include: [args.check] };
    } else {
      checks = { type: 'explicit', checkIds: [args.check] };
      includeDisabled = [args.check];
    }
  } else if (args.tagFilters?.length) {
    checks = { type: 'tags', include: args.tagFilters };
  } else {
    checks = { type: 'all', exclude: [] };
  }

  return {
    id: 'RCP_cli-adhoc',
    name: 'cli-adhoc',
    displayName: 'CLI Ad-Hoc',
    description: 'Dynamically created recipe from CLI arguments',
    checks,
    execution: {
      mode: args.parallel === false ? 'sequential' : 'parallel',
      stopOnFirstFailure: false,
      timeout: args.timeout ?? 30_000,
      maxParallel: args.maxParallel ?? DEFAULT_MAX_PARALLEL,
      retryOnFailure: args.retry,
      maxRetries: args.maxRetries ?? 2,
      successThreshold: args.successThreshold,
    },
    reporting: {
      format: (() => {
        if (!args.json) return 'table' as const;
        return args.unified ? ('unified' as const) : ('json' as const);
      })(),
      verbose: args.verbose ?? false,
    },
    ...(includeDisabled ? { includeDisabled } : {}),
    ...(args.file ? { fileFilter: args.file } : {}),
  };
}