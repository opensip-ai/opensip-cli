/**
 * Export-surface lock for `@opensip-tools/simulation`.
 *
 * The public barrel is the scenario-pack authoring contract: kind-specific
 * scenario builders, target/fault/assertion helpers, recipe definitions, and
 * `simulationTool`. Engine registries, package loading, CLI lifecycle, and
 * recipe execution services live on `@opensip-tools/simulation/internal`.
 *
 * Scope note: type-only exports are erased at runtime and cannot be asserted
 * here. Adding a *value* export to the barrel is a deliberate minor-version act
 * and must be reflected in EXPECTED below (and in the package catalog);
 * removing one is a major change.
 */

import { describe, expect, it } from 'vitest';

import * as barrel from '../index.js';

/** The complete, intended set of runtime value exports. Keep alphabetised. */
const EXPECTED_VALUE_EXPORTS = [
  'ASSERTIONS',
  'SCENARIO_KINDS',
  'ScenarioAbortedError',
  'ScenarioResultBuilder',
  'createEmptyMetrics',
  'defineChaosScenario',
  'defineLoadScenario',
  'defineSimulationRecipe',
  'evaluateAssertion',
  'evaluateOperator',
  'fault',
  'getOperatorDescription',
  'httpTarget',
  'mergeMetrics',
  'resolveMetric',
  'scenarioAborted',
  'simulationTool',
  'sleepWithAbort',
  'tool',
  'updateLatencyMetrics',
  'validateAssertions',
  'validateChaosScenarioConfig',
  'validateLoadScenarioConfig',
].sort();

describe('@opensip-tools/simulation public barrel', () => {
  it('exposes exactly the curated value-export surface', () => {
    const actual = Object.keys(barrel)
      .filter((k) => barrel[k as keyof typeof barrel] !== undefined)
      .sort();
    expect(actual).toEqual(EXPECTED_VALUE_EXPORTS);
  });

  it('exposes `simulationTool` (and its `tool` alias) as the Tool descriptor', () => {
    expect(barrel.simulationTool).toBeDefined();
    expect(barrel.simulationTool.metadata.id).toBe('simulation');
    expect(barrel.tool).toBe(barrel.simulationTool);
  });

  it('does NOT leak engine internals through the barrel', () => {
    for (const leak of [
      'SimulationRecipeRegistry',
      'SimulationRecipeService',
      'builtInSimulationRecipes',
      'clearScenarioRegistry',
      'createScenarioRegistry',
      'currentScenarioRegistry',
      'ensureScenariosLoaded',
      'getRegisteredScenarios',
      'loadAllSimPlugins',
      'readScenarioPackagePreferences',
    ]) {
      expect(barrel).not.toHaveProperty(leak);
    }
  });
});
