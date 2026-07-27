/**
 * @fileoverview Check resolution and filtering for fitness recipe execution
 *
 * Resolves check slugs from recipe selectors and applies disabled-check filtering.
 */

import { logger, ConfigurationError } from '@opensip-cli/core';

import { fitnessErrorCatalog } from '../errors/fitness-error-catalog.js';

import { resolveChecks, validateCheckReferences } from './check-resolution.js';

import type { CheckSelector, FitnessRecipe } from './types.js';
import type { Check, CheckRegistry } from '../framework/registry.js';

const MODULE_FITNESS_RECIPES = 'fitness:recipes';

/**
 * Describe a zero-matched cli-adhoc selector for the "unknown check" error
 * message — the same identifier a user typed on the CLI (`--check` slug/glob
 * or `--tags` value(s)), so the explicit/pattern/tags arms all read as "here
 * is what you asked for and it matched nothing."
 */
function describeZeroMatchSelector(
  checks: Exclude<CheckSelector, { type: 'all' }>,
  missingExplicitChecks: readonly string[],
): string {
  if (checks.type === 'explicit') {
    return missingExplicitChecks[0] ?? checks.checkIds[0] ?? '(unknown)';
  }
  if (checks.type === 'pattern') {
    return checks.include[0] ?? '(unknown)';
  }
  return checks.include.join(', ') || '(unknown)';
}

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

  assertAdhocSelectorMatched(recipe, checks, missingExplicitChecks);

  return checks;
}

/**
 * A CLI ad-hoc run (`--check`/`--tags`) that resolves to zero checks must
 * never silently proceed as a clean, zero-check pass — that reads as a green
 * run to the caller (exit 0, no findings) when the user's selector simply
 * never matched anything. This originally guarded only the `explicit` arm (an
 * unknown exact slug); `pattern` (`--check` glob) and `tags` (`--tags`)
 * selectors fell through entirely, resolving to zero checks with no error.
 *
 * @throws {ConfigurationError} When a cli-adhoc selector matched zero checks.
 */
function assertAdhocSelectorMatched(
  recipe: FitnessRecipe,
  checks: readonly Check[],
  missingExplicitChecks: readonly string[],
): void {
  if (recipe.name !== 'cli-adhoc' || checks.length > 0 || recipe.checks.type === 'all') return;
  const requested = describeZeroMatchSelector(recipe.checks, missingExplicitChecks);
  let message = `No checks match tags '${requested}'.`;
  if (recipe.checks.type === 'explicit') message = `Unknown check '${requested}'.`;
  if (recipe.checks.type === 'pattern') message = `No checks match pattern '${requested}'.`;
  throw new ConfigurationError(message, {
    code: 'FIT.CHECK.UNKNOWN',
    definition: fitnessErrorCatalog.require('FIT.CHECK.UNKNOWN'),
    metadata: { check: requested },
  });
}
