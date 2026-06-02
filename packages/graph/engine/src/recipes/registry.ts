/**
 * @fileoverview Per-RunScope graph recipe registry.
 *
 * Mirrors `GraphRulesRegistry` (`rules/registry.ts`): a per-`RunScope`
 * registry, seeded with the built-in recipes at construction, read via a
 * `currentGraphRecipes()` helper that resolves `currentScope()?.graph?.recipes`
 * with the same not-found guards the rule registry uses. Built on core's
 * generic `RecipeRegistry<GraphRecipe>` base.
 *
 * No module-singletons: the graph tool's `contributeScope` hook constructs
 * a fresh registry per CLI invocation via `createRecipeRegistry()` and
 * attaches it to `scope.graph.recipes`.
 */

import { RecipeRegistry, currentScope } from '@opensip-tools/core';

import { builtInGraphRecipes } from './built-in-recipes.js';

import type { GraphRecipe } from './types.js';

/** Per-RunScope recipe registry, seeded with the built-in graph recipes. */
export class GraphRecipeRegistry extends RecipeRegistry<GraphRecipe> {
  constructor() {
    super({ module: 'graph:recipes', validationCode: 'VALIDATION.GRAPH.RECIPE.DUPLICATE' });
    this.registerAll(builtInGraphRecipes, { internal: true });
  }
}

/** Factory used by the graph tool's `contributeScope` hook. */
export function createRecipeRegistry(): GraphRecipeRegistry {
  return new GraphRecipeRegistry();
}

/**
 * Read the current scope's graph recipe registry. Throws when no scope is
 * active or when the graph subscope is missing — same guards as
 * `currentRules()`.
 *
 * @throws {Error} When called outside `runWithScope(...)`, or when the
 *   active scope has no graph subscope.
 */
export function currentGraphRecipes(): GraphRecipeRegistry {
  const scope = currentScope();
  if (!scope) {
    throw new Error(
      'graph: currentGraphRecipes() called outside a RunScope. ' +
        'Wrap the call site in runWithScope (production: pre-action-hook handles ' +
        'this; tests: use makeTestScope + graphTool.contributeScope).',
    );
  }
  if (!scope.graph) {
    throw new Error(
      'graph: scope.graph is missing. The graph tool must be registered and ' +
        'its contributeScope hook must run before recipe reads.',
    );
  }
  return scope.graph.recipes;
}
