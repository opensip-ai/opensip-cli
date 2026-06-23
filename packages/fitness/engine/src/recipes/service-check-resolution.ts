/**
 * @fileoverview Check resolution and filtering for fitness recipe execution
 *
 * Resolves check slugs from recipe selectors and applies disabled-check filtering.
 */

import { logger, ConfigurationError } from '@opensip-cli/core';

import { resolveChecks, validateCheckReferences } from './check-resolution.js';

import type { FitnessRecipe } from './types.js';
import type { Check, CheckRegistry } from '../framework/registry.js';

const MODULE_FITNESS_RECIPES = 'fitness:recipes';

/** Options for {@link resolveAndFilterChecks}. */
export interface CheckResolutionOptions {
  /** Check slugs disabled via opensip.config.yml. */
  disabledChecks?: readonly string[];
}

/**
 * Resolve checks from a recipe selector and filter out disabled checks.
 * Force-included slugs from `recipe.includeDisabled` bypass the disabled filter.
 */
export function resolveAndFilterChecks(
  recipe: FitnessRecipe,
  checkRegistry: CheckRegistry,
  options: CheckResolutionOptions,
): Check[] {
  const checkSlugs = resolveChecks(recipe.checks, checkRegistry);
  let missingExplicitChecks: readonly string[] = [];

  // Validate explicit references
  if (recipe.checks.type === 'explicit') {
    const allSlugs = checkRegistry.listSlugs();
    const { missing } = validateCheckReferences(recipe.checks.checkIds, [...allSlugs]);
    missingExplicitChecks = missing;
    if (missing.length > 0) {
      logger.warn(`Recipe references ${missing.length} unknown check(s)`, {
        evt: 'fitness.recipe.checks.missing',
        module: MODULE_FITNESS_RECIPES,
        missing,
        recipeName: recipe.name,
      });
    }
  }

  const configDisabled = new Set(options.disabledChecks);
  const includeDisabledSet = new Set(recipe.includeDisabled);
  const checks: Check[] = [];

  // Warn about unknown slugs in disabledChecks config
  if (configDisabled.size > 0) {
    const allSlugs = new Set(checkRegistry.listSlugs());
    const unknownDisabled = [...configDisabled].filter((s) => !allSlugs.has(s));
    if (unknownDisabled.length > 0) {
      logger.warn(`disabledChecks references ${unknownDisabled.length} unknown slug(s)`, {
        evt: 'fitness.recipe.disabled.unknown',
        module: MODULE_FITNESS_RECIPES,
        unknownDisabled,
      });
    }
  }

  for (const slug of checkSlugs) {
    const check = checkRegistry.getBySlug(slug);
    if (!check) continue;
    const bareSlug = slug.includes(':') ? slug.split(':').pop()! : slug;
    const isDisabled =
      (check.config.disabled ?? false) || configDisabled.has(slug) || configDisabled.has(bareSlug);
    const isForceIncluded = includeDisabledSet.has(slug) || includeDisabledSet.has(bareSlug);
    if (!isDisabled || isForceIncluded) {
      checks.push(check);
    }
  }

  if (recipe.name === 'cli-adhoc' && recipe.checks.type === 'explicit' && checks.length === 0) {
    const requested = missingExplicitChecks[0] ?? recipe.checks.checkIds[0] ?? '(unknown)';
    throw new ConfigurationError(`Unknown check '${requested}'.`, {
      code: 'CONFIG.UNKNOWN_CHECK',
      metadata: { check: requested },
    });
  }

  return checks;
}
