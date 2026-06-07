/**
 * @fileoverview Resolve a recipe name → an ordered rule subset.
 *
 * Turns a `--recipe <name>` value into the `readonly Rule[]` the
 * orchestrator runs, using Plan A's generic `resolveSelector` over the
 * scope's rule registry. Graph rules are keyed by slug; the resolver view
 * exposes each rule as `{ id: slug, name: slug }` so core's `explicit`/`all`
 * arms match. Registration order is preserved.
 *
 * Resolution lives in this CLI-adjacent layer (not the engine): the engine
 * stays recipe-agnostic and consumes the resolved subset via
 * `RunGraphInput.rules`.
 */

import { BUILTIN_DEFAULT_RECIPE } from '@opensip-tools/contracts';
import { ConfigurationError, currentScope, logger, resolveSelector, setCurrentRecipeUnitConfig } from '@opensip-tools/core';

import { currentRules } from '../rules/registry.js';

import { currentGraphRecipes } from './registry.js';

import type { RuleSelector } from './types.js';
import type { Rule } from '../types.js';

const UNKNOWN_RECIPE_CODE = 'CONFIGURATION.GRAPH.UNKNOWN_RECIPE';

/** A `Registerable` view over a graph rule (slug = id = name). */
interface RuleView {
  readonly id: string;
  readonly name: string;
  readonly rule: Rule;
}

/**
 * Resolve a recipe name to its ordered rule subset. `undefined` resolves the
 * built-in `default` recipe (all rules).
 *
 * Tolerance (ADR-0022): when `opts.tolerant` is true (the name came from
 * config — `graph.recipe` or the deprecated `cli.recipe` — not an explicit
 * `--recipe` flag) an unknown name falls back to the built-in `default` recipe
 * with a warning instead of aborting, because a shared/cross-tool default may
 * legitimately target another tool. When `opts.tolerant` is false (the default
 * — an explicit flag) an unknown name throws a `ConfigurationError` so the
 * CLI's `handleGraphError` maps it to `EXIT_CODES.CONFIGURATION_ERROR` (typo
 * protection).
 */
export function resolveRecipeToRules(
  name = BUILTIN_DEFAULT_RECIPE,
  opts: { readonly tolerant?: boolean } = {},
): readonly Rule[] {
  const recipes = currentGraphRecipes();
  let recipe = recipes.loadRecipe(name);
  if (!recipe && opts.tolerant === true && name !== BUILTIN_DEFAULT_RECIPE) {
    logger.warn({
      evt: 'graph.recipe.unknown_config_default',
      module: 'graph:recipes',
      requested: name,
      fallback: BUILTIN_DEFAULT_RECIPE,
      msg: `Configured graph recipe '${name}' not found; using '${BUILTIN_DEFAULT_RECIPE}'. If '${name}' is a recipe for another tool, move it under that tool's <tool>.recipe key (ADR-0022).`,
    });
    recipe = recipes.loadRecipe(BUILTIN_DEFAULT_RECIPE);
  }
  if (!recipe) {
    // @fitness-ignore-next-line result-pattern-consistency -- user config error surfaced as a thrown ConfigurationError, mapped to an exit code by handleGraphError
    throw new ConfigurationError(
      `Unknown graph recipe '${name}'. Run 'opensip-tools graph-recipes' to list available recipes.`,
      { code: UNKNOWN_RECIPE_CODE },
    );
  }

  const views: RuleView[] = currentRules().map((rule) => ({ id: rule.slug, name: rule.slug, rule }));
  const selected = resolveSelector<RuleView, RuleSelector>(recipe.rules, views, {
    keysOf: (item) => [item.id],
  });

  // Forward-compat (Plan D): project any per-rule config carried on the
  // selected arm into the scope's recipe-unit-config slot so rules could
  // read it via getUnitConfig. No graph rule reads unit config in Plan B,
  // but wiring it now keeps symmetry with fitness. Best-effort: only when a
  // scope is active and the arm carries config.
  const armConfig = recipe.rules.config;
  if (armConfig) {
    const scope = currentScope();
    if (scope) setCurrentRecipeUnitConfig(scope, armConfig);
  }

  return selected.map((v) => v.rule);
}
