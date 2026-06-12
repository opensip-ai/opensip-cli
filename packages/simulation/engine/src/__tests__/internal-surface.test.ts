/**
 * Export-surface lock for `@opensip-cli/simulation/internal`.
 *
 * `/internal` is the deliberate, test-only escape hatch for simulation engine
 * registry/lifecycle/recipe execution seams. Production packages must use the
 * public barrel and Tool contract; dependency-cruiser enforces that boundary.
 */

import { describe, expect, it } from 'vitest';

import * as internal from '../internal.js';

/** The complete, intended set of test-only value exports. Keep alphabetised. */
const EXPECTED_INTERNAL_EXPORTS = [
  'SimulationRecipeRegistry',
  'SimulationRecipeService',
  'builtInSimulationRecipes',
  'builtInSimulationRecipesByName',
  'clearScenarioRegistry',
  'createScenarioRegistry',
  'createSimulationRecipeRegistry',
  'currentScenarioRegistry',
  'currentSimulationRecipeRegistry',
  'ensureScenariosLoaded',
  'getRegisteredScenarios',
  'getScenario',
  'getScenariosByKind',
  'getScenariosByTag',
  'isBuiltInSimulationRecipe',
  'loadAllSimPlugins',
  'readScenarioPackagePreferences',
].sort();

describe('@opensip-cli/simulation/internal surface', () => {
  it('exposes exactly the intended test-only value surface', () => {
    const actual = Object.keys(internal)
      .filter((k) => internal[k as keyof typeof internal] !== undefined)
      .sort();
    expect(actual).toEqual(EXPECTED_INTERNAL_EXPORTS);
  });
});
