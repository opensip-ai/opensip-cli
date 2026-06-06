/**
 * @fileoverview Cross-cutting surface tests that don't belong to a single
 * kind: the metric resolver's latency aliases, registry/recipe scope guards,
 * and the recipe service's live-progress callback.
 *
 * The driver, fault model, and per-kind executor behaviour are covered by the
 * dedicated framework/execution and per-kind executor test suites.
 */

import { enterScope, RunScope, runWithScopeSync } from '@opensip-tools/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ASSERTIONS } from '../framework/assertions.js';
import {
  clearScenarioRegistry,
  currentScenarioRegistry,
} from '../framework/registry.js';
import { resolveMetric } from '../framework/resolve-metric.js';
import { defineLoadScenario } from '../kinds/load/define.js';
import { currentSimulationRecipeRegistry } from '../recipes/registry.js';
import { SimulationRecipeService } from '../recipes/service.js';

import { noopTarget } from './test-utils/targets.js';
import { makeSimTestScope } from './test-utils/with-sim-scope.js';

import type { ScenarioMetricKey } from '../framework/resolve-metric.js';
import type { LoadScenarioConfig } from '../kinds/load/config.js';
import type { SimulationMetrics } from '../types/base-types.js';

beforeEach(() => {
  enterScope(makeSimTestScope());
});

afterEach(() => {
  try {
    clearScenarioRegistry();
  } catch {
    // some tests deliberately run outside a scope
  }
});

const loadConfig = (overrides: Partial<LoadScenarioConfig> = {}): LoadScenarioConfig => ({
  id: 'load-edge',
  name: 'load-edge',
  description: 'load edge',
  tags: [],
  target: noopTarget,
  workload: { rps: 1 },
  duration: 1,
  assertions: [ASSERTIONS.lowErrorRate(1)],
  ...overrides,
});

// ===========================================================================
// registry scope guards
// ===========================================================================

describe('scenario/recipe registry scope guards', () => {
  it('currentScenarioRegistry throws when the active scope has no simulation subscope', () => {
    // A bare RunScope (no simulationTool.contributeScope applied) is a real
    // misconfiguration: the tool wasn't registered before a scenario read.
    runWithScopeSync(new RunScope(), () => {
      expect(() => currentScenarioRegistry()).toThrow(/scope\.simulation is missing/);
    });
  });

  it('currentSimulationRecipeRegistry throws when the active scope has no simulation subscope', () => {
    runWithScopeSync(new RunScope(), () => {
      expect(() => currentSimulationRecipeRegistry()).toThrow(/scope\.simulation is missing/);
    });
  });

  it('currentSimulationRecipeRegistry resolves the scope-bound registry inside a sim scope', () => {
    // Inside the beforeEach sim scope the recipe registry is reachable and has
    // the built-in default recipe.
    expect(currentSimulationRecipeRegistry().getByName('default')).toBeDefined();
  });
});

// ===========================================================================
// resolve-metric — non-`_ms` latency aliases
// ===========================================================================

describe('resolveMetric — latency key aliases', () => {
  const m: SimulationMetrics = {
    totalRequests: 100,
    successfulRequests: 90,
    failedRequests: 10,
    avgLatencyMs: 41,
    p50LatencyMs: 30,
    p95LatencyMs: 70,
    p99LatencyMs: 120,
    errorsGenerated: 10,
  };

  it.each<[ScenarioMetricKey, number]>([
    ['avg_latency', 41],
    ['p50_latency', 30],
    ['p95_latency', 70],
    ['p99_latency', 120],
  ])('resolves the %s alias to the corresponding *_ms field', (key, expected) => {
    expect(resolveMetric(key, m)).toBe(expected);
  });

  it('resolves requests_per_second using the supplied duration', () => {
    expect(resolveMetric('requests_per_second', m, 10)).toBeCloseTo(10);
  });

  it('returns 0 for errors_generated passthrough when none recorded', () => {
    expect(resolveMetric('errors_generated', { ...m, errorsGenerated: 0 })).toBe(0);
  });
});

// ===========================================================================
// recipe service — live-progress callback
// ===========================================================================

describe('SimulationRecipeService — onProgress', () => {
  it('fires (0, total) up front then a monotonic completed count per scenario', async () => {
    currentScenarioRegistry().register(defineLoadScenario(loadConfig({ id: 'prog-a', name: 'prog-a' })));
    currentScenarioRegistry().register(defineLoadScenario(loadConfig({ id: 'prog-b', name: 'prog-b' })));

    const events: [number, number][] = [];
    const service = new SimulationRecipeService({
      onProgress: (completed, total) => events.push([completed, total]),
    });
    await service.runRecipe({
      id: 'URCP_prog',
      name: 'prog',
      displayName: 'Prog',
      description: 'progress',
      scenarios: { type: 'all' },
      execution: { mode: 'sequential' },
    });

    // First event is the (0, total) kickoff.
    expect(events[0]).toEqual([0, 2]);
    // Final event reports both scenarios complete.
    expect(events.at(-1)).toEqual([2, 2]);
    // The completed counter never decreases.
    const completedSeq = events.map(([c]) => c);
    for (let i = 1; i < completedSeq.length; i++) {
      expect(completedSeq[i]).toBeGreaterThanOrEqual(completedSeq[i - 1] ?? 0);
    }
  });
});
