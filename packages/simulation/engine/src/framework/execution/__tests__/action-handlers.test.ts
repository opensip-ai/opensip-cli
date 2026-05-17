/**
 * @fileoverview Unit tests for action-handlers — the per-tick request loop.
 *
 * `executeTickRequests` is the inner action loop in the simulation engine.
 * It exercises chaos injection, action success/failure metrics, signal
 * emission and filtering, and abort propagation. The pieces aren't
 * exported individually, so we drive them via `executeTickRequests`.
 */

import { describe, expect, it } from 'vitest';

import { createEmptyMetrics } from '../../result-builder.js';
import {
  executeTickRequests,
  type ActionExecutionContext,
  type SimulationActionResult,
  type SimulationLoopContext,
} from '../action-handlers.js';
import { ScenarioAbortedError } from '../scenario-aborted-error.js';

import type { ChaosConfig, Persona, PersonaConfig } from '../../../types/base-types.js';
import type { Signal } from '@opensip-tools/core';

// ---------------------------------------------------------------------------
// Test fixtures (hoisted to module scope to satisfy unicorn/consistent-function-scoping)
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

const resolvePersona = (_cfg: PersonaConfig): Persona => personaInstance;

const makeCtx = (signal: AbortSignal = new AbortController().signal): ActionExecutionContext => ({
  signal,
  correlationId: 'corr-1',
  scenarioId: 'sid-1',
  checkAborted: () => {
    if (signal.aborted) throw new ScenarioAbortedError('sid-1');
  },
});

const makeLoopContext = (
  overrides: Partial<SimulationLoopContext> = {},
): SimulationLoopContext => ({
  metrics: createEmptyMetrics(),
  signals: [],
  scenarioId: 'sid-1',
  correlationId: 'corr-1',
  ...overrides,
});

const trackLatency = (_metrics: { avgLatencyMs: number; totalRequests: number }, _l: number): void => {
  // Latency tracking is exercised separately in latency-tracker tests; here we only
  // need a noop so the call site doesn't crash.
  return;
};

// Pre-bound action functions (hoisted to satisfy `consistent-function-scoping`).
const successAction = (): Promise<SimulationActionResult> =>
  Promise.resolve({ success: true, duration: 12 });

const successAction1 = (): Promise<SimulationActionResult> =>
  Promise.resolve({ success: true, duration: 1 });

const failedActionWithError = (): Promise<SimulationActionResult> =>
  Promise.resolve({
    success: false,
    duration: 5,
    actionType: 'POST /api',
    error: new Error('bad request'),
  });

const failedActionNoError = (): Promise<SimulationActionResult> =>
  Promise.resolve({ success: false, duration: 5 });

const failedActionMinimal = (): Promise<SimulationActionResult> =>
  Promise.resolve({ success: false, duration: 1 });

const throwingAction = (): Promise<SimulationActionResult> =>
  Promise.reject(new Error('action exploded'));

// Reject with a non-Error to exercise the fallback path in handleActionError.
// We cast to a Promise<never> so TS accepts a string rejection without using
// the lint-banned form (Promise.reject('...')) directly.
const stringRejectAction = (): Promise<SimulationActionResult> =>
  // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- intentionally non-Error to verify fallback message path
  Promise.reject('string-thrown');

const abortRejectAction = (): Promise<SimulationActionResult> =>
  Promise.reject(new ScenarioAbortedError('sid-1'));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeTickRequests — successful actions', () => {
  it('records each successful action under successfulRequests', async () => {
    const loop = makeLoopContext();
    await executeTickRequests(3, { personas: [personaCfg] }, makeCtx(), successAction, resolvePersona, loop, trackLatency);

    expect(loop.metrics.totalRequests).toBe(3);
    expect(loop.metrics.successfulRequests).toBe(3);
    expect(loop.metrics.failedRequests).toBe(0);
    expect(loop.signals).toHaveLength(0);
  });

  it('emits an action-failed signal when the action returns success=false', async () => {
    const loop = makeLoopContext();
    await executeTickRequests(1, { personas: [personaCfg] }, makeCtx(), failedActionWithError, resolvePersona, loop, trackLatency);

    expect(loop.metrics.failedRequests).toBe(1);
    expect(loop.metrics.errorsGenerated).toBe(1);
    expect(loop.signals).toHaveLength(1);
    expect(loop.signals[0]?.ruleId).toBe('sim:action-failed');
    expect(loop.signals[0]?.message).toContain('bad request');
    expect(loop.metrics.findingsGenerated).toBe(1);
  });

  it('falls back to a generic message when the failed action has no error', async () => {
    const loop = makeLoopContext();
    await executeTickRequests(1, { personas: [personaCfg] }, makeCtx(), failedActionNoError, resolvePersona, loop, trackLatency);

    expect(loop.signals[0]?.message).toBe('Action failed');
    expect(loop.signals[0]?.metadata.endpoint).toBe('unknown-action');
  });
});

describe('executeTickRequests — exceptions', () => {
  it('emits an action-exception signal when executeAction throws', async () => {
    const loop = makeLoopContext();
    await executeTickRequests(1, { personas: [personaCfg] }, makeCtx(), throwingAction, resolvePersona, loop, trackLatency);

    expect(loop.metrics.failedRequests).toBe(1);
    expect(loop.metrics.errorsGenerated).toBe(1);
    expect(loop.signals).toHaveLength(1);
    expect(loop.signals[0]?.ruleId).toBe('sim:action-exception');
    expect(loop.signals[0]?.message).toBe('action exploded');
  });

  it('uses a fallback message when a non-Error is thrown', async () => {
    const loop = makeLoopContext();
    await executeTickRequests(1, { personas: [personaCfg] }, makeCtx(), stringRejectAction, resolvePersona, loop, trackLatency);

    expect(loop.signals[0]?.message).toBe('Unknown error');
  });

  it('re-throws ScenarioAbortedError without recording a signal', async () => {
    const loop = makeLoopContext();
    await expect(
      executeTickRequests(1, { personas: [personaCfg] }, makeCtx(), abortRejectAction, resolvePersona, loop, trackLatency),
    ).rejects.toThrow(ScenarioAbortedError);
    expect(loop.signals).toHaveLength(0);
  });
});

describe('executeTickRequests — chaos injection', () => {
  it('records a chaos-error signal when an error injection fires', async () => {
    const chaos: ChaosConfig = {
      enabled: true,
      probability: 1,
      types: [
        {
          type: 'error',
          target: '*',
          probability: 1,
          config: { type: 'error', statusCode: 500, message: 'forced-error' },
        },
      ],
    };
    const loop = makeLoopContext();
    let actionInvocations = 0;
    const exec = (): Promise<SimulationActionResult> => {
      actionInvocations++;
      return Promise.resolve({ success: true, duration: 1 });
    };

    await executeTickRequests(
      1,
      { personas: [personaCfg], chaosConfig: chaos },
      makeCtx(),
      exec,
      resolvePersona,
      loop,
      trackLatency,
    );

    expect(actionInvocations).toBe(0); // chaos short-circuits the action
    expect(loop.metrics.failedRequests).toBe(1);
    expect(loop.metrics.errorsGenerated).toBe(1);
    expect(loop.signals[0]?.ruleId).toBe('sim:chaos-error-injected');
    expect(loop.signals[0]?.message).toBe('forced-error');
  });

  it('records a chaos-timeout signal when a timeout injection fires', async () => {
    const chaos: ChaosConfig = {
      enabled: true,
      probability: 1,
      types: [
        {
          type: 'timeout',
          target: '*',
          probability: 1,
          config: { type: 'timeout', afterMs: 10 },
        },
      ],
    };
    const loop = makeLoopContext();
    await executeTickRequests(
      1,
      { personas: [personaCfg], chaosConfig: chaos },
      makeCtx(),
      successAction1,
      resolvePersona,
      loop,
      trackLatency,
    );

    expect(loop.signals[0]?.ruleId).toBe('sim:chaos-timeout-injected');
    expect(loop.metrics.failedRequests).toBe(1);
  });

  it('falls back to a generic message when chaos error has no message', async () => {
    const chaos: ChaosConfig = {
      enabled: true,
      probability: 1,
      types: [
        {
          type: 'error',
          target: '*',
          probability: 1,
          // @ts-expect-error -- intentionally exercising the no-message fallback path
          config: { type: 'error', statusCode: 500 },
        },
      ],
    };
    const loop = makeLoopContext();
    await executeTickRequests(
      1,
      { personas: [personaCfg], chaosConfig: chaos },
      makeCtx(),
      successAction1,
      resolvePersona,
      loop,
      trackLatency,
    );

    expect(loop.signals[0]?.message).toBe('Chaos error injected');
  });

  it('latency injection does not stop the action — action runs and is recorded', async () => {
    const chaos: ChaosConfig = {
      enabled: true,
      probability: 1,
      types: [
        {
          type: 'latency',
          target: '*',
          probability: 1,
          config: { type: 'latency', minMs: 1, maxMs: 2 },
        },
      ],
    };
    const loop = makeLoopContext();
    let invoked = 0;
    const exec = (): Promise<SimulationActionResult> => {
      invoked++;
      return Promise.resolve({ success: true, duration: 1 });
    };

    await executeTickRequests(
      1,
      { personas: [personaCfg], chaosConfig: chaos },
      makeCtx(),
      exec,
      resolvePersona,
      loop,
      trackLatency,
    );

    // Latency chaos doesn't short-circuit; the action still runs.
    expect(invoked).toBe(1);
    expect(loop.metrics.successfulRequests).toBe(1);
  });

  it('does not inject when chaos.enabled is false', async () => {
    const chaos: ChaosConfig = {
      enabled: false,
      probability: 1,
      types: [
        {
          type: 'error',
          target: '*',
          probability: 1,
          config: { type: 'error', statusCode: 500, message: 'never' },
        },
      ],
    };
    const loop = makeLoopContext();
    await executeTickRequests(
      1,
      { personas: [personaCfg], chaosConfig: chaos },
      makeCtx(),
      successAction1,
      resolvePersona,
      loop,
      trackLatency,
    );

    expect(loop.metrics.successfulRequests).toBe(1);
    expect(loop.signals).toHaveLength(0);
  });

  it('handles missing chaosConfig (undefined)', async () => {
    const loop = makeLoopContext();
    await executeTickRequests(
      1,
      { personas: [personaCfg] },
      makeCtx(),
      successAction1,
      resolvePersona,
      loop,
      trackLatency,
    );

    expect(loop.metrics.successfulRequests).toBe(1);
  });

  it('skips injection when probability check fails (probability=0 means no roll fires)', async () => {
    const chaos: ChaosConfig = {
      enabled: true,
      probability: 1,
      types: [
        {
          type: 'error',
          target: '*',
          probability: 0,
          config: { type: 'error', statusCode: 500, message: 'never' },
        },
      ],
    };
    const loop = makeLoopContext();
    await executeTickRequests(
      1,
      { personas: [personaCfg], chaosConfig: chaos },
      makeCtx(),
      successAction1,
      resolvePersona,
      loop,
      trackLatency,
    );

    expect(loop.metrics.successfulRequests).toBe(1);
    expect(loop.signals).toHaveLength(0);
  });
});

describe('executeTickRequests — signal filtering and onSignal callback', () => {
  it('invokes onSignal for each emitted signal', async () => {
    const seen: Signal[] = [];
    const loop = makeLoopContext({
      onSignal: (s) => {
        seen.push(s);
      },
    });
    await executeTickRequests(2, { personas: [personaCfg] }, makeCtx(), failedActionMinimal, resolvePersona, loop, trackLatency);

    expect(seen).toHaveLength(2);
    expect(seen[0]?.ruleId).toBe('sim:action-failed');
  });

  it('signalFilter=false drops the signal entirely (no push, no findingsGenerated++)', async () => {
    const loop = makeLoopContext({
      signalFilter: () => false,
    });
    await executeTickRequests(1, { personas: [personaCfg] }, makeCtx(), failedActionMinimal, resolvePersona, loop, trackLatency);

    expect(loop.metrics.failedRequests).toBe(1);
    expect(loop.signals).toHaveLength(0);
    expect(loop.metrics.findingsGenerated).toBe(0);
  });
});

describe('executeTickRequests — abort + persona edge cases', () => {
  it('throws ScenarioAbortedError before invoking executeAction when aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const loop = makeLoopContext();
    let invoked = 0;
    const exec = (): Promise<SimulationActionResult> => {
      invoked++;
      return Promise.resolve({ success: true, duration: 1 });
    };

    await expect(
      executeTickRequests(
        1,
        { personas: [personaCfg] },
        makeCtx(ac.signal),
        exec,
        resolvePersona,
        loop,
        trackLatency,
      ),
    ).rejects.toThrow(ScenarioAbortedError);
    expect(invoked).toBe(0);
  });

  it('skips the iteration silently when persona list is empty', async () => {
    const loop = makeLoopContext();
    let invoked = 0;
    const exec = (): Promise<SimulationActionResult> => {
      invoked++;
      return Promise.resolve({ success: true, duration: 1 });
    };

    await executeTickRequests(3, { personas: [] }, makeCtx(), exec, resolvePersona, loop, trackLatency);

    expect(invoked).toBe(0);
    expect(loop.metrics.totalRequests).toBe(0);
  });
});
