/**
 * @fileoverview Behaviour tests for the surviving load/chaos surface edges left
 * uncovered after the `invariant` / `fix-evaluation` kinds were removed.
 *
 * Every test asserts a real semantic outcome — fault-injection probability
 * gating, the recovery window, the load-window tick driver's outcome
 * accounting, validation rejections, registry scope guards, and recipe
 * progress callbacks — not raw line execution.
 */

import { enterScope, RunScope, runWithScopeSync } from '@opensip-tools/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ASSERTIONS } from '../framework/assertions.js';
import { runLoadWindow } from '../framework/execution/run-load-window.js';
import { persona } from '../framework/personas.js';
import {
  clearScenarioRegistry,
  currentScenarioRegistry,
} from '../framework/registry.js';
import { resolveMetric } from '../framework/resolve-metric.js';
import {
  defineChaosScenario,
  validateChaosScenarioConfig,
} from '../kinds/chaos/define.js';
import { createChaosScenarioRunner } from '../kinds/chaos/executor.js';
import {
  defineLoadScenario,
  validateLoadScenarioConfig,
} from '../kinds/load/define.js';
import { createLoadScenarioRunner } from '../kinds/load/executor.js';
import { currentSimulationRecipeRegistry } from '../recipes/registry.js';
import { SimulationRecipeService } from '../recipes/service.js';

import { makeSimTestScope } from './test-utils/with-sim-scope.js';

import type { ScenarioMetricKey } from '../framework/resolve-metric.js';
import type { ChaosScenarioConfig } from '../kinds/chaos/config.js';
import type { LoadScenarioConfig } from '../kinds/load/config.js';
import type { SimulationMetrics } from '../types/base-types.js';
import type { ScenarioExecutionContext } from '../types/framework-types.js';

const ctx = (signal: AbortSignal): ScenarioExecutionContext => ({
  scenarioId: 'edge',
  correlationId: 'edge-corr',
  abortSignal: signal,
  logger: {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
});

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

// ===========================================================================
// runLoadWindow — tick-outcome accounting (the chaos/load shared driver)
// ===========================================================================

describe('runLoadWindow — explicit tick outcomes', () => {
  const config = {
    duration: 1,
    targetRps: 200,
    personas: [persona('user', 1)],
  };

  it("counts every 'success' outcome as a successful request, never a failure", async () => {
    const result = await runLoadWindow(config, ctx(new AbortController().signal), {
      windowMs: 30,
      injectChaos: () => ({ kind: 'success' }),
    });
    // Every issued request reported success → zero failures, zero errors.
    expect(result.metrics.totalRequests).toBeGreaterThan(0);
    expect(result.metrics.failedRequests).toBe(0);
    expect(result.metrics.errorsGenerated).toBe(0);
    expect(result.metrics.successfulRequests).toBe(result.metrics.totalRequests);
    expect(result.events).toHaveLength(0);
  });

  it("counts a 'failure' outcome as a failed request with an error", async () => {
    const result = await runLoadWindow(config, ctx(new AbortController().signal), {
      windowMs: 30,
      injectChaos: () => ({ kind: 'failure' }),
    });
    expect(result.metrics.totalRequests).toBeGreaterThan(0);
    expect(result.metrics.successfulRequests).toBe(0);
    expect(result.metrics.failedRequests).toBe(result.metrics.totalRequests);
    expect(result.metrics.errorsGenerated).toBe(result.metrics.failedRequests);
  });

  it('emits a LoadWindowEvent for each chaos-event outcome', async () => {
    const result = await runLoadWindow<'error'>(config, ctx(new AbortController().signal), {
      windowMs: 30,
      injectChaos: ({ tickStartMs }) => ({
        kind: 'chaos-event',
        event: { type: 'error', atMs: tickStartMs, target: 'svc' },
      }),
    });
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events[0]?.type).toBe('error');
    expect(result.events[0]?.target).toBe('svc');
    // chaos events are also accounted as failed requests.
    expect(result.metrics.failedRequests).toBe(result.metrics.totalRequests);
  });

  it('returns immediately when the signal is already aborted (no requests issued)', async () => {
    const ac = new AbortController();
    ac.abort();
    const result = await runLoadWindow(config, ctx(ac.signal), { windowMs: 1000 });
    // The loop's first abort check breaks before issuing any request.
    expect(result.metrics.totalRequests).toBe(0);
  });
});

// ===========================================================================
// chaos executor — probability gating + recovery window
// ===========================================================================

const chaosConfig = (overrides: Partial<ChaosScenarioConfig> = {}): ChaosScenarioConfig => ({
  id: 'chaos-edge',
  name: 'chaos-edge',
  description: 'chaos edge',
  tags: ['chaos'],
  personas: [persona('user', 1)],
  duration: 1,
  targetRps: 100,
  chaos: {
    enabled: true,
    probability: 1,
    types: [
      {
        type: 'error',
        target: 'api',
        probability: 1,
        config: { type: 'error', statusCode: 500, message: 'boom' },
      },
    ],
  },
  steadyStateAssertions: [ASSERTIONS.lowErrorRate(1)],
  recoveryAssertions: [ASSERTIONS.lowErrorRate(1)],
  recoveryWindow: 50,
  ...overrides,
});

describe('chaos executor — fault injection probability', () => {
  it('injects no chaos events when probability is 0 even though chaos is enabled', async () => {
    const runner = createChaosScenarioRunner(
      chaosConfig({ chaos: { enabled: true, probability: 0, types: chaosConfig().chaos.types } }),
    );
    const result = await runner.run(new AbortController().signal);
    expect(result.kind).toBe('chaos');
    if (result.kind === 'chaos') {
      // probability 0 ⇒ injectChaos always defers (returns null) ⇒ no events.
      expect(result.outcome.chaosEvents).toHaveLength(0);
    }
  });

  it('records chaos events during the steady window when probability is 1', async () => {
    const runner = createChaosScenarioRunner(chaosConfig());
    const result = await runner.run(new AbortController().signal);
    if (result.kind === 'chaos') {
      expect(result.outcome.chaosEvents.length).toBeGreaterThan(0);
      // Every steady-window event carries the configured injection type/target.
      expect(result.outcome.chaosEvents[0]?.type).toBe('error');
      expect(result.outcome.chaosEvents[0]?.target).toBe('api');
      // The recovery window is reported and runs with chaos lifted.
      expect(result.outcome.recoveryWindowMs).toBe(50);
    }
  });

  it('counts a generic failure (no chaos event) when chaos is active but no injection types are defined', async () => {
    const runner = createChaosScenarioRunner(
      chaosConfig({ chaos: { enabled: true, probability: 1, types: [] } }),
    );
    const result = await runner.run(new AbortController().signal);
    if (result.kind === 'chaos') {
      // No injection definition ⇒ every active tick is a generic failure, not a
      // chaos event — so failures accrue but the event list stays empty.
      expect(result.outcome.chaosEvents).toHaveLength(0);
      expect(result.outcome.steadyStateMetrics.failedRequests).toBeGreaterThan(0);
    }
  });

  it('throws ScenarioAbortedError when the signal is already aborted at start', async () => {
    const runner = createChaosScenarioRunner(chaosConfig());
    const ac = new AbortController();
    ac.abort();
    await expect(runner.run(ac.signal)).rejects.toThrow(/abort/i);
  });
});

// ===========================================================================
// chaos validation edges
// ===========================================================================

describe('validateChaosScenarioConfig — metadata edges', () => {
  it('rejects an empty personas list', () => {
    expect(() =>
      validateChaosScenarioConfig(chaosConfig({ personas: [] })),
    ).toThrow(/at least one persona is required/);
  });

  it('rejects a non-positive duration', () => {
    expect(() =>
      validateChaosScenarioConfig(chaosConfig({ duration: 0 })),
    ).toThrow(/duration must be a positive number/);
  });

  it('accepts a fully-valid chaos config via defineChaosScenario', () => {
    const scenario = defineChaosScenario(chaosConfig());
    expect(scenario.kind).toBe('chaos');
  });
});

// ===========================================================================
// load validation + custom-executor edges
// ===========================================================================

const loadConfig = (overrides: Partial<LoadScenarioConfig> = {}): LoadScenarioConfig => ({
  id: 'load-edge',
  name: 'load-edge',
  description: 'load edge',
  tags: [],
  personas: [persona('user', 1)],
  duration: 5,
  assertions: [ASSERTIONS.lowErrorRate(1)],
  ...overrides,
});

describe('validateLoadScenarioConfig — edges', () => {
  it('rejects rampUp greater than the duration', () => {
    expect(() =>
      validateLoadScenarioConfig(loadConfig({ duration: 2, rampUp: 5 })),
    ).toThrow(/rampUp cannot exceed duration/);
  });

  it('rejects a persona entry missing a personaId', () => {
    // An empty personaId triggers the per-index persona validator.
    expect(() =>
      validateLoadScenarioConfig(
        loadConfig({ personas: [{ personaId: '', count: 1, spawnRate: 0.5, actions: ['random'] }] }),
      ),
    ).toThrow(/personaId is required/);
  });
});

describe('createLoadScenarioRunner — custom execute path', () => {
  it('wraps a custom execute payload into a load-kind result envelope', async () => {
    const metrics: SimulationMetrics = {
      totalRequests: 10,
      successfulRequests: 10,
      failedRequests: 0,
      avgLatencyMs: 5,
      p50LatencyMs: 4,
      p95LatencyMs: 9,
      p99LatencyMs: 10,
      errorsGenerated: 0,
      findingsGenerated: 0,
    };
    const runner = createLoadScenarioRunner(
      loadConfig({
        execute: () =>
          Promise.resolve({
            passed: true,
            metrics,
            assertions: { passed: [], failed: [] },
            signals: [],
          }),
      }),
    );
    const result = await runner.run(new AbortController().signal);
    expect(result.kind).toBe('load');
    if (result.kind === 'load') {
      // The custom payload's metrics flow straight through to the outcome.
      expect(result.outcome.metrics.totalRequests).toBe(10);
      expect(result.passed).toBe(true);
    }
  });
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
    findingsGenerated: 2,
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
    currentScenarioRegistry().register(defineLoadScenario(loadConfig({ id: 'prog-a', name: 'prog-a', duration: 1 })));
    currentScenarioRegistry().register(defineLoadScenario(loadConfig({ id: 'prog-b', name: 'prog-b', duration: 1 })));

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
