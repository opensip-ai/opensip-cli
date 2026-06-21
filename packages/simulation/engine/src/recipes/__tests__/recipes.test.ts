// @fitness-ignore-file file-length-limit -- behavior fixture suite; related scenarios stay together while covered domains are split into focused tests.

/**
 * @fileoverview Sim-recipe contract + integration tests.
 *
 * Covers: defineSimulationRecipe shape validation, registry round-trip,
 * built-in `default` recipe presence, and SimulationRecipeService
 * resolving each selector type against the live scenario registry.
 */

import { enterScope } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { noopTarget } from '../../__tests__/test-utils/targets.js';
import { makeSimTestScope } from '../../__tests__/test-utils/with-sim-scope.js';
import { ASSERTIONS } from '../../framework/assertions.js';
import { fault } from '../../framework/execution/fault-builders.js';
import { clearScenarioRegistry, currentScenarioRegistry } from '../../framework/registry.js';
import { defineChaosScenario } from '../../kinds/chaos/define.js';
import { defineLoadScenario } from '../../kinds/load/define.js';
import { isBuiltInSimulationRecipe } from '../built-in-recipes.js';
import { defineSimulationRecipe } from '../define-recipe.js';
import { SimulationRecipeRegistry } from '../registry.js';
import { SimulationRecipeService } from '../service.js';

import type { RunnableScenario } from '../../framework/runnable-scenario.js';
import type { ScenarioExecutorResult } from '../../framework/scenario-executor-result.js';

// Helper: build a minimal RunnableScenario for tests. The shape matches
// RunnableScenario but uses a stub LoadOutcome via type assertion so we
// don't need to construct the full domain payload for control-flow tests.
function makeStubScenario(id: string, run: () => Promise<unknown>): RunnableScenario {
  return {
    id,
    name: id,
    description: id,
    kind: 'load',
    tags: [],
    run: run as (sig: AbortSignal) => Promise<ScenarioExecutorResult>,
  };
}

const stubLoadResult = (id: string) =>
  Promise.resolve({
    kind: 'load' as const,
    scenarioId: id,
    passed: true,
    durationMs: 0,
    signals: [] as const,
  });

beforeEach(() => {
  // Item 1: scenarioRegistry + recipe registry are per-RunScope.
  // Each test enters a fresh scope with sim subscope attached.
  enterScope(makeSimTestScope());
});

afterEach(() => {
  clearScenarioRegistry();
});

// =============================================================================
// SimulationRecipeService — parallel concurrency (maxParallel)
// =============================================================================

const trackingScenario = (id: string, peak: { active: number; max: number }) =>
  makeStubScenario(id, async () => {
    peak.active++;
    peak.max = Math.max(peak.max, peak.active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    peak.active--;
    return stubLoadResult(id);
  });

describe('SimulationRecipeService — parallel concurrency', () => {
  it('caps in-flight scenarios at recipe.execution.maxParallel', async () => {
    const peak = { active: 0, max: 0 };
    for (let i = 0; i < 6; i++)
      currentScenarioRegistry().register(trackingScenario(`p-${i}`, peak));
    const recipe = defineSimulationRecipe({
      id: 'URCP_par_bound',
      name: 'par-bound',
      displayName: 'Par bound',
      description: 'bounded parallel',
      scenarios: { type: 'all' },
      execution: { mode: 'parallel', maxParallel: 2 },
    });

    const result = await new SimulationRecipeService().runRecipe(recipe);

    expect(result.totalScenarios).toBe(6);
    expect(peak.max).toBeGreaterThan(0);
    expect(peak.max).toBeLessThanOrEqual(2);
  });

  it('runs unbounded when maxParallel is unset', async () => {
    const peak = { active: 0, max: 0 };
    for (let i = 0; i < 4; i++)
      currentScenarioRegistry().register(trackingScenario(`u-${i}`, peak));
    const recipe = defineSimulationRecipe({
      id: 'URCP_par_unbounded',
      name: 'par-unbounded',
      displayName: 'Par unbounded',
      description: 'unbounded parallel',
      scenarios: { type: 'all' },
      execution: { mode: 'parallel' },
    });

    await new SimulationRecipeService().runRecipe(recipe);

    expect(peak.max).toBe(4);
  });
});

// =============================================================================
// SimulationRecipeService — execution.timeout (release 2.13.0, §4.3 fix)
// =============================================================================

describe('SimulationRecipeService — execution.timeout', () => {
  it('ABORTS a runaway scenario via execution.timeout and reports it failed', async () => {
    // A scenario that never resolves on its own — only the substrate's timeout
    // abort can end it. Before 2.13.0 `execution.timeout` was silently ignored
    // and this would hang forever.
    const runaway: RunnableScenario = {
      id: 'runaway',
      name: 'runaway',
      description: 'never resolves on its own',
      kind: 'load',
      tags: [],
      run: (signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    };
    currentScenarioRegistry().register(runaway);
    const recipe = defineSimulationRecipe({
      id: 'URCP_timeout',
      name: 'timeout',
      displayName: 'Timeout',
      description: 'enforces a short timeout',
      scenarios: { type: 'all' },
      execution: { mode: 'sequential', timeout: 50 },
    });

    const result = await new SimulationRecipeService().runRecipe(recipe);

    expect(result.totalScenarios).toBe(1);
    expect(result.failedScenarios).toBe(1);
    expect(result.scenarios[0]?.passed).toBe(false);
    expect(result.scenarios[0]?.error).toContain('timed out after 50ms');
  });
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

  it('isBuiltInSimulationRecipe identifies built-in names', () => {
    expect(isBuiltInSimulationRecipe('default')).toBe(true);
    expect(isBuiltInSimulationRecipe('user-recipe')).toBe(false);
  });

  it('throws when execution block is missing', () => {
    expect(() =>
      defineSimulationRecipe({
        id: 'URCP_test',
        name: 'test',
        displayName: 'Test',
        description: 'x',
        scenarios: { type: 'all' },
        // @ts-expect-error — testing the runtime guard
        execution: undefined,
      }),
    ).toThrow(/missing required `execution`/);
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

  it('loadRecipe accepts both name and id', () => {
    const registry = new SimulationRecipeRegistry();
    expect(registry.loadRecipe('default')).toBeDefined();
    expect(registry.loadRecipe('BSCP_default')).toBeDefined();
    expect(registry.loadRecipe('nope')).toBeUndefined();
  });

  it('getByName / getById / has return the right answers', () => {
    const registry = new SimulationRecipeRegistry();
    expect(registry.getById('BSCP_default')).toBeDefined();
    expect(registry.getById('NOPE')).toBeUndefined();
    expect(registry.has('default')).toBe(true);
    expect(registry.has('BSCP_default')).toBe(true);
    expect(registry.has('nope')).toBe(false);
  });

  it('size, getAllRecipes, and getNames reflect the registered set', () => {
    const registry = new SimulationRecipeRegistry();
    expect(registry.size).toBeGreaterThan(0);
    expect(registry.getAllRecipes().length).toBe(registry.size);
    expect(registry.getNames()).toContain('default');
  });

  it('registerAll mounts every recipe in a list', () => {
    const registry = new SimulationRecipeRegistry();
    registry.clear();
    registry.registerAll([
      {
        id: 'URCP_a',
        name: 'a',
        displayName: 'A',
        description: 'a',
        scenarios: { type: 'all' },
        execution: { mode: 'parallel' },
      },
      {
        id: 'URCP_b',
        name: 'b',
        displayName: 'B',
        description: 'b',
        scenarios: { type: 'all' },
        execution: { mode: 'parallel' },
      },
    ]);
    expect(registry.size).toBe(2);
  });

  it('remove returns true on hit, false on miss', () => {
    const registry = new SimulationRecipeRegistry();
    expect(registry.remove('BSCP_default')).toBe(true);
    expect(registry.has('default')).toBe(false);
    expect(registry.remove('BSCP_default')).toBe(false);
  });

  it('listForDisplay distinguishes built-in vs user-defined', () => {
    const registry = new SimulationRecipeRegistry();
    registry.register({
      id: 'URCP_user',
      name: 'user',
      displayName: 'User',
      description: 'd',
      scenarios: { type: 'all' },
      execution: { mode: 'parallel' },
    });
    const display = registry.listForDisplay();
    expect(display.find((d) => d.name === 'default')?.isBuiltIn).toBe(true);
    expect(display.find((d) => d.name === 'user')?.isUserDefined).toBe(true);
  });
});

// =============================================================================
// SimulationRecipeService — selector resolution + execution
// =============================================================================

function defineThreeScenarios(): void {
  currentScenarioRegistry().register(
    defineLoadScenario({
      id: 'load-a',
      name: 'load-a',
      description: 'load',
      tags: ['fast', 'demo'],
      target: noopTarget,
      workload: { rps: 1 },
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate(1)],
    }),
  );
  currentScenarioRegistry().register(
    defineLoadScenario({
      id: 'load-b',
      name: 'load-b',
      description: 'load',
      tags: ['slow'],
      target: noopTarget,
      workload: { rps: 1 },
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate(1)],
    }),
  );
  currentScenarioRegistry().register(
    defineChaosScenario({
      id: 'chaos-a',
      name: 'chaos-a',
      description: 'chaos',
      tags: ['demo'],
      target: noopTarget,
      workload: { rps: 1 },
      duration: 1,
      fault: fault.of([fault.drop()], { probability: 0.1 }),
      steadyStateAssertions: [ASSERTIONS.lowErrorRate(1)],
      recoveryAssertions: [ASSERTIONS.lowErrorRate(0.5)],
      recoveryWindowMs: 100,
    }),
  );
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

  it('selector type=all honors the exclude list', async () => {
    defineThreeScenarios();
    const service = new SimulationRecipeService();
    const result = await service.runRecipe({
      id: 'URCP_test',
      name: 'test',
      displayName: 'Test',
      description: 'x',
      scenarios: { type: 'all', exclude: ['load-a'] },
      execution: { mode: 'parallel' },
    });
    expect(result.totalScenarios).toBe(2);
    expect(result.scenarios.map((s) => s.scenarioId)).not.toContain('load-a');
  });

  it('selector type=tags honors the exclude list', async () => {
    defineThreeScenarios();
    const service = new SimulationRecipeService();
    const result = await service.runRecipe({
      id: 'URCP_test',
      name: 'test',
      displayName: 'Test',
      description: 'x',
      scenarios: { type: 'tags', include: ['demo'], exclude: ['chaos-a'] },
      execution: { mode: 'parallel' },
    });
    expect(result.totalScenarios).toBe(1);
    expect(result.scenarios[0]?.scenarioId).toBe('load-a');
  });
});

describe('SimulationRecipeService — execution modes + failure handling', () => {
  it('records a failed scenario when run() throws and continues with the rest', async () => {
    currentScenarioRegistry().register(
      makeStubScenario('failing', () => Promise.reject(new Error('boom'))),
    );
    currentScenarioRegistry().register(
      makeStubScenario('passing', () => stubLoadResult('passing')),
    );

    const service = new SimulationRecipeService();
    const result = await service.runRecipe({
      id: 'URCP_test',
      name: 'test',
      displayName: 'Test',
      description: 'x',
      scenarios: { type: 'all' },
      execution: { mode: 'parallel' },
    });

    expect(result.totalScenarios).toBe(2);
    expect(result.failedScenarios).toBe(1);
    expect(result.passedScenarios).toBe(1);
    const failing = result.scenarios.find((s) => s.scenarioId === 'failing');
    expect(failing?.passed).toBe(false);
    expect(failing?.error).toContain('boom');
  });

  it('runs sequentially when execution.mode === sequential', async () => {
    const order: string[] = [];
    currentScenarioRegistry().register(
      makeStubScenario('first', () => {
        order.push('first');
        return stubLoadResult('first');
      }),
    );
    currentScenarioRegistry().register(
      makeStubScenario('second', () => {
        order.push('second');
        return stubLoadResult('second');
      }),
    );

    const service = new SimulationRecipeService();
    await service.runRecipe({
      id: 'URCP_test',
      name: 'test',
      displayName: 'Test',
      description: 'x',
      scenarios: { type: 'all' },
      execution: { mode: 'sequential' },
    });

    expect(order).toEqual(['first', 'second']);
  });

  it('stops on first failure in sequential mode when stopOnFirstFailure is set', async () => {
    const order: string[] = [];
    currentScenarioRegistry().register(
      makeStubScenario('crashes', () => {
        order.push('crashes');
        return Promise.reject(new Error('nope'));
      }),
    );
    currentScenarioRegistry().register(
      makeStubScenario('never-runs', () => {
        order.push('never-runs');
        return stubLoadResult('never-runs');
      }),
    );

    const service = new SimulationRecipeService();
    const result = await service.runRecipe({
      id: 'URCP_test',
      name: 'test',
      displayName: 'Test',
      description: 'x',
      scenarios: { type: 'all' },
      execution: { mode: 'sequential', stopOnFirstFailure: true },
    });

    expect(order).toEqual(['crashes']);
    expect(result.scenarios).toHaveLength(1);
  });

  it('respects an aborted signal in sequential mode', async () => {
    currentScenarioRegistry().register(makeStubScenario('s1', () => stubLoadResult('s1')));
    currentScenarioRegistry().register(makeStubScenario('s2', () => stubLoadResult('s2')));

    const ac = new AbortController();
    ac.abort();
    const service = new SimulationRecipeService({ abortSignal: ac.signal });
    const result = await service.runRecipe({
      id: 'URCP_test',
      name: 'test',
      displayName: 'Test',
      description: 'x',
      scenarios: { type: 'all' },
      execution: { mode: 'sequential' },
    });

    // Pre-aborted: nothing runs
    expect(result.totalScenarios).toBe(0);
  });
});
