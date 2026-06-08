/**
 * @fileoverview Built-in sim recipes.
 *
 * Currently only `default` ships built-in. Mirrors fitness's pattern:
 * `opensip-tools sim` (no flag) runs `default`, which selects all
 * registered scenarios.
 *
 * Additional built-ins (e.g. `chaos-only`, `load-only`) can be added
 * here when the surface earns it. Today, scenarios are sparse enough
 * that one default is sufficient.
 */

import { deriveRecipeId } from '@opensip-tools/core';

import { defineSimulationRecipe } from './define-recipe.js';

import type { SimulationRecipe } from './types.js';

// Release 2.13.0 (§5.8): the built-in authors through the `defineSimulationRecipe`
// factory and derives its id via the shared `deriveRecipeId('BSCP', name)` scheme
// (`BSCP_default`, unchanged) — recipe-factory + id-scheme parity with fit/graph.
const DEFAULT: SimulationRecipe = defineSimulationRecipe({
  id: deriveRecipeId('BSCP', 'default'),
  name: 'default',
  displayName: 'Default',
  description: 'Run all enabled scenarios in parallel',
  scenarios: { type: 'all' },
  execution: {
    mode: 'parallel',
    timeout: 60_000,
    stopOnFirstFailure: false,
  },
  tags: ['default'],
});

export const builtInSimulationRecipes: readonly SimulationRecipe[] = [DEFAULT];

export const builtInSimulationRecipesByName: Readonly<Record<string, SimulationRecipe>> = {
  default: DEFAULT,
};

export function isBuiltInSimulationRecipe(name: string): boolean {
  return name in builtInSimulationRecipesByName;
}
