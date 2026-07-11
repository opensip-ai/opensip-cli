/**
 * Export-surface lock for `@opensip-cli/simulation/internal`.
 *
 * `/internal` is excluded from the root barrel but deliberately published as an
 * explicit `./internal` subpath export — a test-only escape hatch for simulation
 * engine registry/lifecycle/recipe execution seams (ADR-0009). Production
 * packages must use the public barrel and Tool contract; dependency-cruiser
 * enforces that boundary.
 */

import { describe, expect, it } from 'vitest';

import * as root from '../index.js';
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
].sort();

describe('@opensip-cli/simulation/internal surface', () => {
  it('exposes exactly the intended test-only value surface', () => {
    const actual = Object.keys(internal)
      .filter((k) => internal[k as keyof typeof internal] !== undefined)
      .sort();
    expect(actual).toEqual(EXPECTED_INTERNAL_EXPORTS);
  });

  it('is a published test-only subpath, NOT part of the root API', () => {
    // `./internal` and `.` are distinct package export conditions. None of the
    // registry/lifecycle seams may leak into the root barrel — production code
    // reaches simulation only through the public `.` API and the Tool contract.
    const rootKeys = new Set(Object.keys(root));
    const leaked = EXPECTED_INTERNAL_EXPORTS.filter((name) => rootKeys.has(name));
    expect(leaked).toEqual([]);
  });
});
