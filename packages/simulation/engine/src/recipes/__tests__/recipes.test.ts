 
/**
 * @fileoverview Sim-recipe contract + integration tests.
 *
 * Covers: defineSimulationRecipe shape validation, registry round-trip,
 * built-in `default` recipe presence, and SimulationRecipeService
 * resolving each selector type against the live scenario registry.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { ASSERTIONS } from '../../framework/assertions.js';
import { persona } from '../../framework/personas.js';
import { clearScenarioRegistry } from '../../framework/registry.js';
import { defineChaosScenario } from '../../kinds/chaos/define.js';
import { defineLoadScenario } from '../../kinds/load/define.js';
import { defineSimulationRecipe } from '../define-recipe.js';
import {
  SimulationRecipeRegistry,
  defaultSimulationRecipeRegistry,
} from '../registry.js';
import { SimulationRecipeService } from '../service.js';

afterEach(() => {
  clearScenarioRegistry();
  // Reset the default registry to its built-in state so user recipes
  // registered during a test don't leak into the next.
  defaultSimulationRecipeRegistry.reset();
});

// =============================================================================
// defineSimulationRecipe — shape validation
// =============================================================================

describe('defineSimulationRecipe', () => {
  it('validates a complete recipe and returns it unchanged', () => {
    const recipe = defineSimulationRecipe({
      id: 'URCP_test',
      name: 'test',
      displayName: 'Test',
      description: 'Test recipe',
      scenarios: { type: 'all' },
      execution: { mode: 'parallel' },
    });
    expect(recipe.id).toBe('URCP_test');
    expect(recipe.name).toBe('test');
  });

  it('throws when id is missing', () => {
    expect(() =>
      defineSimulationRecipe({
        // @ts-expect-error — testing the runtime guard
        id: undefined,
        name: 'test',
        displayName: 'Test',
        description: 'x',
        scenarios: { type: 'all' },
        execution: { mode: 'parallel' },
      }),
    ).toThrow(/missing required `id`/);
  });

  it('throws when name is missing', () => {
    expect(() =>
      defineSimulationRecipe({
        id: 'URCP_test',
        // @ts-expect-error — testing the runtime guard
        name: undefined,
        displayName: 'Test',
        description: 'x',
        scenarios: { type: 'all' },
        execution: { mode: 'parallel' },
      }),
    ).toThrow(/missing required `name`/);
  });

  it('throws when scenarios selector is missing', () => {
    expect(() =>
      defineSimulationRecipe({
        id: 'URCP_test',
        name: 'test',
        displayName: 'Test',
        description: 'x',
        // @ts-expect-error — testing the runtime guard
        scenarios: undefined,
        execution: { mode: 'parallel' },
      }),
    ).toThrow(/missing required `scenarios`/);
  });
});

// =============================================================================
// Registry — built-in default + round-trip
// =============================================================================

describe('SimulationRecipeRegistry', () => {
  it('pre-loads the built-in `default` recipe', () => {
    const registry = new SimulationRecipeRegistry();
    const def = registry.getByName('default');
    expect(def).toBeDefined();
    expect(def?.scenarios.type).toBe('all');
  });

  it('refuses to overwrite a registered recipe by default', () => {
    const registry = new SimulationRecipeRegistry();
    expect(() =>
      registry.register({
        id: 'BSCP_default',
        name: 'default',
        displayName: 'X',
        description: 'x',
        scenarios: { type: 'all' },
        execution: { mode: 'parallel' },
      }),
    ).toThrow(/already registered/);
  });

  it('allows overwrite when explicitly requested', () => {
    const registry = new SimulationRecipeRegistry();
    registry.register(
      {
        id: 'BSCP_default',
        name: 'default',
        displayName: 'Override',
        description: 'overridden',
        scenarios: { type: 'all' },
        execution: { mode: 'sequential' },
      },
      { allowOverwrite: true },
    );
    expect(registry.getByName('default')?.displayName).toBe('Override');
    expect(registry.getByName('default')?.execution.mode).toBe('sequential');
  });

  it('reset() restores built-in recipes after clear()', () => {
    const registry = new SimulationRecipeRegistry();
    registry.clear();
    expect(registry.getByName('default')).toBeUndefined();
    registry.reset();
    expect(registry.getByName('default')).toBeDefined();
  });
});

// =============================================================================
// SimulationRecipeService — selector resolution + execution
// =============================================================================

function defineThreeScenarios(): void {
  defineLoadScenario({
    id: 'load-a',
    name: 'load-a',
    description: 'load',
    tags: ['fast', 'demo'],
    personas: [persona('user', 1)],
    duration: 1,
    assertions: [ASSERTIONS.lowErrorRate(1)],
  });
  defineLoadScenario({
    id: 'load-b',
    name: 'load-b',
    description: 'load',
    tags: ['slow'],
    personas: [persona('user', 1)],
    duration: 1,
    assertions: [ASSERTIONS.lowErrorRate(1)],
  });
  defineChaosScenario({
    id: 'chaos-a',
    name: 'chaos-a',
    description: 'chaos',
    tags: ['demo'],
    personas: [persona('user', 1)],
    duration: 1,
    chaos: {
      enabled: true,
      probability: 0.1,
      types: [
        {
          type: 'error',
          target: '*',
          probability: 0.5,
          config: { type: 'error', statusCode: 500, message: 'injected' },
        },
      ],
    },
    steadyStateAssertions: [ASSERTIONS.lowErrorRate(1)],
    recoveryAssertions: [ASSERTIONS.lowErrorRate(0.5)],
    recoveryWindow: 100,
  });
}

describe('SimulationRecipeService — selector resolution', () => {
  it('selector type=all selects every registered scenario', async () => {
    defineThreeScenarios();
    const service = new SimulationRecipeService();
    const result = await service.runRecipe({
      id: 'URCP_test',
      name: 'test',
      displayName: 'Test',
      description: 'x',
      scenarios: { type: 'all' },
      execution: { mode: 'parallel' },
    });
    expect(result.totalScenarios).toBe(3);
  });

  it('selector type=explicit selects only listed scenarios', async () => {
    defineThreeScenarios();
    const service = new SimulationRecipeService();
    const result = await service.runRecipe({
      id: 'URCP_test',
      name: 'test',
      displayName: 'Test',
      description: 'x',
      scenarios: { type: 'explicit', scenarioIds: ['load-a'] },
      execution: { mode: 'parallel' },
    });
    expect(result.totalScenarios).toBe(1);
    expect(result.scenarios[0]?.scenarioId).toBe('load-a');
  });

  it('selector type=tags includes only tagged scenarios', async () => {
    defineThreeScenarios();
    const service = new SimulationRecipeService();
    const result = await service.runRecipe({
      id: 'URCP_test',
      name: 'test',
      displayName: 'Test',
      description: 'x',
      scenarios: { type: 'tags', include: ['demo'] },
      execution: { mode: 'parallel' },
    });
    expect(result.totalScenarios).toBe(2);
  });

  it('selector type=kind narrows to a kind', async () => {
    defineThreeScenarios();
    const service = new SimulationRecipeService();
    const result = await service.runRecipe({
      id: 'URCP_test',
      name: 'test',
      displayName: 'Test',
      description: 'x',
      scenarios: { type: 'kind', kinds: ['chaos'] },
      execution: { mode: 'parallel' },
    });
    expect(result.totalScenarios).toBe(1);
    expect(result.scenarios[0]?.kind).toBe('chaos');
  });

  it('returns empty result when no scenarios match', async () => {
    const service = new SimulationRecipeService();
    const result = await service.runRecipe({
      id: 'URCP_test',
      name: 'test',
      displayName: 'Test',
      description: 'x',
      scenarios: { type: 'all' },
      execution: { mode: 'parallel' },
    });
    expect(result.totalScenarios).toBe(0);
    expect(result.passedScenarios).toBe(0);
    expect(result.failedScenarios).toBe(0);
  });
});
