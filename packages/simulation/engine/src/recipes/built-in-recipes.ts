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

import type { SimulationRecipe } from './types.js';

const DEFAULT: SimulationRecipe = {
  id: 'BSCP_default',
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
};

export const builtInSimulationRecipes: readonly SimulationRecipe[] = [DEFAULT];

export const builtInSimulationRecipesByName: Readonly<Record<string, SimulationRecipe>> = {
  default: DEFAULT,
};

export function isBuiltInSimulationRecipe(name: string): boolean {
  return name in builtInSimulationRecipesByName;
}
