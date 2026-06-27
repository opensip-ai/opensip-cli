/**
 * @fileoverview Built-in graph recipes.
 *
 * Mirrors fitness's `built-in-recipes.ts`: a `default` recipe meaning "all
 * rules" (selected when `--recipe` is absent — zero behavior change vs.
 * today's `BUILT_IN_RULES`), plus a frozen array + by-name map + a
 * membership predicate. The `{ type: 'all' }` selector over the rule
 * registry returns every rule in registration order (core's resolver
 * preserves registry order), so `--recipe default` === no `--recipe`.
 */

import { defineGraphRecipe, type GraphRecipe } from './types.js';

/** The default recipe: every registered graph rule, registration order. */
export const defaultGraphRecipe: GraphRecipe = defineGraphRecipe({
  name: 'default',
  displayName: 'Default',
  description: 'Run all graph rules',
  rules: { type: 'all' },
  tags: ['comprehensive', 'default'],
});

/**
 * A demonstrative subset recipe: the two reachability/dead-code rules. Gives
 * `--recipe` something to select beyond `default` and makes the dashboard
 * Recipes subtab non-trivial. Uses the real rule slugs.
 */
export const deadCodeGraphRecipe: GraphRecipe = defineGraphRecipe({
  name: 'dead-code',
  displayName: 'Dead Code',
  description: 'Reachability rules: orphan subtrees and test-only-reachable functions',
  rules: {
    type: 'explicit',
    ids: ['graph:orphan-subtree', 'graph:test-only-reachable'],
  },
  tags: ['dead-code'],
});

/** Agent-risk: high-impact graph rules for agent risk passes. */
export const agentRiskGraphRecipe: GraphRecipe = defineGraphRecipe({
  name: 'agent-risk',
  displayName: 'Agent Risk',
  description: 'High-impact graph rules: blast, cycles, large/wide functions',
  rules: {
    type: 'explicit',
    ids: [
      'graph:high-blast-untested',
      'graph:cycle',
      'graph:large-function',
      'graph:wide-function',
    ],
  },
  tags: ['agent', 'risk'],
});

/** Agent-final: all rules — handoff gate convention. */
export const agentFinalGraphRecipe: GraphRecipe = defineGraphRecipe({
  name: 'agent-final',
  displayName: 'Agent Final',
  description: 'All graph rules — agent handoff / gate-compare convention',
  rules: { type: 'all' },
  tags: ['agent', 'final'],
});

/** All built-in graph recipes, frozen, `default` first. */
export const builtInGraphRecipes: readonly GraphRecipe[] = Object.freeze([
  defaultGraphRecipe,
  deadCodeGraphRecipe,
  agentRiskGraphRecipe,
  agentFinalGraphRecipe,
]);

/** By-name lookup for the built-in recipes. */
export const builtInGraphRecipesByName: ReadonlyMap<string, GraphRecipe> = new Map(
  builtInGraphRecipes.map((r) => [r.name, r]),
);

/** True when `name` is a built-in graph recipe. */
export function isBuiltInGraphRecipe(name: string): boolean {
  return builtInGraphRecipesByName.has(name);
}
