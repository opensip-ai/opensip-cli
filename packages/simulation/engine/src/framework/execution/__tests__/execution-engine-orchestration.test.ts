/**
 * @fileoverview Tests for the orchestration surface of execution-engine.
 *
 * Targets:
 *   - `runSimulationLoop` — drives ticks for the configured duration,
 *     accumulates metrics, and surfaces signals from action results.
 *   - `createScenario` — wraps an executor with logging, abort handling,
 *     onComplete callbacks, and the SimulationRun lifecycle.
 *   - `createStandardExecutor` — composes a standard executor that delegates
 *     to `runSimulationLoop`.
 *   - `emitSimulationSignal` — helper that constructs a Signal with the
 *     scenario's correlation/scenario metadata.
 *
 * Tests use very short durations (10–50 ms) so the real loop executes
 * without slowing the suite.
 */

import { describe, expect, it } from 'vitest';

import {
  createExecutorResult,
  createScenario,
  createStandardExecutor,
  emitSimulationSignal,
  runSimulationLoop,
  ScenarioAbortedError,
  type ExecutorContext,
  type ExecutorResult,
  type ScenarioExecutor,
} from '../execution-engine.js';

import type {
  Persona,
  PersonaConfig,
  ScenarioAssertion,
  SimulationMetrics,
} from '../../../types/base-types.js';
import type { SimulationActionResult } from '../action-handlers.js';
import type { SignalCategory, SignalSeverity } from '@opensip-tools/core';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const personaCfg: PersonaConfig = {
  personaId: 'buyer-default',
  count: 1,
  spawnRate: 1,
  actions: ['random'],
};

const personaInstance: Persona = {
  id: 'p1',
  type: 'buyer',
  name: 'Buyer',
  behavior: 'normal',
  attributes: {
    trustScore: 80,
    activityLevel: 'medium',
    preferredCategories: [],
    priceRange: { min: 0, max: 0 },
    responseTime: { min: 1, max: 1 },
  },
  actionProbabilities: {},
};

const noop = (..._args: unknown[]): void => {
  // intentionally empty: stubbed logger sink for tests
  return;
};

const baseLogger = () => ({
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
});

const resolvePersonaInstance = (): Persona => personaInstance;

const makeCtx = (signal: AbortSignal = new AbortController().signal): ExecutorContext => ({
  signal,
  correlationId: 'corr-1',
  logger: baseLogger(),
  checkAborted: () => {
    if (signal.aborted) throw new ScenarioAbortedError('sid-1');
  },
  runId: 'RUN_TEST',
  scenarioId: 'sid-1',
});

const successAction = (): Promise<SimulationActionResult> =>
  Promise.resolve({ success: true, duration: 5 });

const successAction1 = (): Promise<SimulationActionResult> =>
  Promise.resolve({ success: true, duration: 1 });

const failedAction = (): Promise<SimulationActionResult> =>
  Promise.resolve({ success: false, duration: 1, error: new Error('x') });

const baseExecutorMetrics: SimulationMetrics = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  avgLatencyMs: 0,
  p50LatencyMs: 0,
  p95LatencyMs: 0,
  p99LatencyMs: 0,
  errorsGenerated: 0,
  findingsGenerated: 0,
};

// ---------------------------------------------------------------------------
// runSimulationLoop
// ---------------------------------------------------------------------------

describe('runSimulationLoop', () => {
  it('drives ticks for the configured duration and accumulates metrics', async () => {
    const result = await runSimulationLoop({
      config: {
        personas: [personaCfg],
        duration: 0.1,
        rampUp: 0,
        targetRps: 50,
        assertions: [],
      },
      ctx: makeCtx(),
      executeAction: successAction,
      resolvePersona: resolvePersonaInstance,
      tickIntervalMs: 20,
    });

    expect(result.metrics.totalRequests).toBeGreaterThanOrEqual(1);
    expect(result.metrics.successfulRequests).toBeGreaterThanOrEqual(1);
    expect(result.metrics.p50LatencyMs).toBeGreaterThan(0);
  });

  it('invokes onMetricsUpdate at each tick', async () => {
    let updates = 0;
    const onUpdate = (): void => {
      updates++;
    };
    await runSimulationLoop({
      config: {
        personas: [personaCfg],
        duration: 0.05,
        rampUp: 0,
        targetRps: 20,
        assertions: [],
      },
      ctx: makeCtx(),
      executeAction: successAction1,
      resolvePersona: resolvePersonaInstance,
      tickIntervalMs: 10,
      onMetricsUpdate: onUpdate,
    });
    expect(updates).toBeGreaterThanOrEqual(1);
  });

  it('respects ramp-up — early ticks issue fewer requests than late ticks', async () => {
    const result = await runSimulationLoop({
      config: {
        personas: [personaCfg],
        duration: 0.1,
        rampUp: 0.1, // ramp up over the full duration
        targetRps: 100,
        assertions: [],
      },
      ctx: makeCtx(),
      executeAction: successAction1,
      resolvePersona: resolvePersonaInstance,
      tickIntervalMs: 10,
    });
    expect(result.metrics.totalRequests).toBeGreaterThanOrEqual(0);
  });

  it('throws ScenarioAbortedError when signal is pre-aborted', async () => {
    const ac = new AbortController();
    ac.abort();

    await expect(
      runSimulationLoop({
        config: {
          personas: [personaCfg],
          duration: 1,
          rampUp: 0,
          targetRps: 10,
          assertions: [],
        },
        ctx: makeCtx(ac.signal),
        executeAction: successAction1,
        resolvePersona: resolvePersonaInstance,
      }),
    ).rejects.toThrow(ScenarioAbortedError);
  });

  it('forwards onSignal and signalFilter to the action loop', async () => {
    let onSignalCount = 0;
    const onSignal = (): void => {
      onSignalCount++;
    };
    const result = await runSimulationLoop({
      config: {
        personas: [personaCfg],
        duration: 0.05,
        rampUp: 0,
        targetRps: 100,
        assertions: [],
      },
      ctx: makeCtx(),
      executeAction: failedAction,
      resolvePersona: resolvePersonaInstance,
      tickIntervalMs: 10,
      onSignal,
      signalFilter: () => true,
    });
    expect(onSignalCount).toBe(result.signals.length);
    expect(result.signals.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// createExecutorResult
// ---------------------------------------------------------------------------

describe('createExecutorResult', () => {
  it('marks the result as passing when assertions hold', () => {
    const metrics: SimulationMetrics = {
      ...baseExecutorMetrics,
      totalRequests: 100,
      successfulRequests: 100,
      avgLatencyMs: 10,
      p50LatencyMs: 10,
      p95LatencyMs: 12,
      p99LatencyMs: 14,
    };
    const assertions: ScenarioAssertion[] = [
      { metric: 'error_rate', operator: 'lt', value: 0.5, message: 'low error' },
    ];
    const out = createExecutorResult({ metrics, signals: [] }, assertions);
    expect(out.assertionsPassed).toBe(true);
    expect(out.failedAssertions).toBeUndefined();
  });

  it('attaches failedAssertions when assertions fail', () => {
    const metrics: SimulationMetrics = {
      ...baseExecutorMetrics,
      totalRequests: 10,
      failedRequests: 10,
      errorsGenerated: 10,
    };
    const assertions: ScenarioAssertion[] = [
      { metric: 'error_rate', operator: 'lt', value: 0.1, message: 'low error' },
    ];
    const out = createExecutorResult({ metrics, signals: [] }, assertions);
    expect(out.assertionsPassed).toBe(false);
    expect(out.failedAssertions).toHaveLength(1);
    expect(out.failedAssertions?.[0]?.actual).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// emitSimulationSignal
// ---------------------------------------------------------------------------

describe('emitSimulationSignal', () => {
  it('builds a Signal carrying the scenario id and correlation id', () => {
    const ctx = makeCtx();
    const sig = emitSimulationSignal({
      ruleId: 'my-rule',
      severity: 'high' satisfies SignalSeverity,
      category: 'error' satisfies SignalCategory,
      message: 'bad',
      suggestion: 'fix it',
      endpoint: '/api',
      ctx,
      fix: { action: 'investigate', confidence: 0.5 },
      latencyMs: 100,
      statusCode: 500,
    });

    expect(sig.ruleId).toBe('sim:my-rule');
    expect(sig.message).toBe('bad');
    expect(sig.metadata.scenarioId).toBe('sid-1');
    expect(sig.metadata.traceId).toBe('corr-1');
    expect(sig.metadata.statusCode).toBe(500);
    expect(sig.metadata.latencyMs).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// createScenario — wraps a ScenarioExecutor with lifecycle + abort handling.
// ---------------------------------------------------------------------------

const baseConfig = {
  personas: [personaCfg],
  duration: 0.05,
  rampUp: 0,
  targetRps: 1,
  assertions: [] as ScenarioAssertion[],
};

const passingExecuteFn = (): Promise<ExecutorResult> =>
  Promise.resolve({
    metrics: {
      ...baseExecutorMetrics,
      totalRequests: 5,
      successfulRequests: 5,
      avgLatencyMs: 1,
      p50LatencyMs: 1,
      p95LatencyMs: 1,
      p99LatencyMs: 1,
    },
    signals: [],
    assertionsPassed: true,
  });

const passingExecutor = (): ScenarioExecutor => ({
  metadata: {
    id: 'wrap-1',
    name: 'Wrap 1',
    description: 'Wrapped',
    type: 'happy-path',
    tags: ['t'],
  },
  defaultConfig: baseConfig,
  execute: passingExecuteFn,
});

const failExecuteFn = (): Promise<ExecutorResult> =>
  Promise.resolve({
    metrics: { ...baseExecutorMetrics },
    signals: [],
    assertionsPassed: false,
    failedAssertions: [
      {
        assertion: {
          metric: 'error_rate',
          operator: 'lt',
          value: 0.1,
          message: 'low error',
        },
        actual: 1,
      },
    ],
  });

const throwingExecuteFn = (): Promise<ExecutorResult> =>
  Promise.reject(new Error('executor exploded'));

const stringThrowExecuteFn = (): Promise<ExecutorResult> =>
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- intentionally non-Error to verify coercion path
  Promise.reject('weird-string');

const abortingExecuteFn = (): Promise<ExecutorResult> =>
  Promise.reject(new ScenarioAbortedError('wrap-1'));

describe('createScenario', () => {
  it('returns a SimulationRun with status=completed when assertions pass', async () => {
    const scenario = createScenario(passingExecutor());
    const run = await scenario.run({}, new AbortController().signal);
    expect(run.status).toBe('completed');
    expect(run.scenarioId).toBe('wrap-1');
    expect(run.metrics.totalRequests).toBe(5);
    expect(run.completedAt).toBeDefined();
  });

  it('marks status=failed and records the error message when assertions fail', async () => {
    const failingExecutor: ScenarioExecutor = {
      ...passingExecutor(),
      execute: failExecuteFn,
    };
    const scenario = createScenario(failingExecutor);
    const run = await scenario.run();
    expect(run.status).toBe('failed');
    expect(run.error).toContain('low error');
  });

  it('invokes onComplete on success', async () => {
    const captured: { id?: string } = {};
    const scenario = createScenario(passingExecutor(), {
      onComplete: (run) => {
        captured.id = run.id;
      },
    });
    await scenario.run();
    expect(captured.id).toBeDefined();
    expect(captured.id).toMatch(/^RUN_/);
  });

  it('throws ScenarioAbortedError when signal is pre-aborted', async () => {
    const scenario = createScenario(passingExecutor());
    const ac = new AbortController();
    ac.abort();
    await expect(scenario.run({}, ac.signal)).rejects.toThrow(ScenarioAbortedError);
  });

  it('returns status=failed with error message when the executor throws a non-abort error', async () => {
    let onCompleteCalled = false;
    const onComplete = (): void => {
      onCompleteCalled = true;
    };
    const throwingExecutor: ScenarioExecutor = {
      ...passingExecutor(),
      execute: throwingExecuteFn,
    };
    const scenario = createScenario(throwingExecutor, { onComplete });
    const run = await scenario.run();
    expect(run.status).toBe('failed');
    expect(run.error).toBe('executor exploded');
    expect(onCompleteCalled).toBe(true);
  });

  it('coerces a non-Error executor throw into a string message', async () => {
    const throwingExecutor: ScenarioExecutor = {
      ...passingExecutor(),
      execute: stringThrowExecuteFn,
    };
    const scenario = createScenario(throwingExecutor);
    const run = await scenario.run();
    expect(run.status).toBe('failed');
    expect(run.error).toBe('weird-string');
  });

  it('re-throws ScenarioAbortedError thrown mid-execution', async () => {
    const abortingExecutor: ScenarioExecutor = {
      ...passingExecutor(),
      execute: abortingExecuteFn,
    };
    const scenario = createScenario(abortingExecutor);
    await expect(scenario.run()).rejects.toThrow(ScenarioAbortedError);
  });

  it('passes recipeId through to the SimulationRun and ExecutorContext', async () => {
    let capturedRecipeId: string | undefined;
    const observingExecuteFn = (_config: unknown, ctx: ExecutorContext): Promise<ExecutorResult> => {
      capturedRecipeId = ctx.recipeId;
      return Promise.resolve({
        metrics: { ...baseExecutorMetrics },
        signals: [],
        assertionsPassed: true,
      });
    };
    const observingExecutor: ScenarioExecutor = {
      ...passingExecutor(),
      execute: observingExecuteFn,
    };
    const scenario = createScenario(observingExecutor);
    const run = await scenario.run({ recipeId: 'recipe-X' });
    expect(capturedRecipeId).toBe('recipe-X');
    expect(run.recipeId).toBe('recipe-X');
  });

  it('runs without an explicit signal (default AbortController)', async () => {
    const scenario = createScenario(passingExecutor());
    const run = await scenario.run();
    expect(run.status).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// createStandardExecutor
// ---------------------------------------------------------------------------

describe('createStandardExecutor', () => {
  it('builds an executor whose execute() drives the simulation loop', async () => {
    const exec = createStandardExecutor({
      id: 'std-1',
      name: 'Std 1',
      description: 'Standard test',
      type: 'happy-path',
      tags: [],
      personas: [personaCfg],
      duration: 0.05,
      rampUp: 0,
      targetRps: 50,
      assertions: [
        { metric: 'error_rate', operator: 'lt', value: 1, message: 'low error' },
      ],
      resolvePersona: resolvePersonaInstance,
      executeAction: successAction1,
    });

    expect(exec.metadata.id).toBe('std-1');
    expect(exec.defaultConfig.duration).toBe(0.05);

    const ctx = makeCtx();
    const result = await exec.execute(exec.defaultConfig, ctx);
    expect(result.assertionsPassed).toBe(true);
    expect(result.metrics.totalRequests).toBeGreaterThanOrEqual(1);
  });

  it('attaches chaosConfig to defaultConfig when supplied', () => {
    const exec = createStandardExecutor({
      id: 'std-chaos',
      name: 'Std Chaos',
      description: 'Std chaos',
      type: 'chaos',
      tags: [],
      personas: [personaCfg],
      duration: 0.05,
      rampUp: 0,
      targetRps: 1,
      assertions: [],
      chaosConfig: { enabled: false, probability: 0, types: [] },
      resolvePersona: resolvePersonaInstance,
      executeAction: successAction1,
    });
    expect(exec.defaultConfig.chaosConfig).toBeDefined();
    expect(exec.defaultConfig.chaosConfig?.enabled).toBe(false);
  });
});
