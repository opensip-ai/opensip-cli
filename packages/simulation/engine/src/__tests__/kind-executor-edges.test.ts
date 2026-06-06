// @fitness-ignore-file file-length-limit -- aggregate coverage-driven test fixture; splitting destroys the contract
/* eslint-disable @typescript-eslint/require-await -- scenario phase hooks must match `() => Promise<void>` shape; some test stubs are intentionally synchronous bodies */
/**
 * @fileoverview Edge-case tests for each kind's executor.
 *
 * Each executor has a try/catch around its run loop that converts
 * mid-run aborts into ScenarioAbortedError and re-throws non-abort
 * errors. These paths weren't reached by the smoke tests; this file
 * targets them via the public defineXxx + .run() surface, plus the no-reg
 * helpers, so coverage hits the catch branches without source mods.
 *
 * It also exercises the load executor's custom-execute branch — that
 * path delegates to a user-supplied execute function and isn't reached
 * by any of the existing smoke tests.
 */

import { enterScope } from '@opensip-tools/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { ASSERTIONS } from '../framework/assertions.js';
import { ScenarioAbortedError } from '../framework/execution/scenario-aborted-error.js';
import { persona } from '../framework/personas.js';
import { defineChaosScenario } from '../kinds/chaos/define.js';
import { defineLoadScenario } from '../kinds/load/define.js';

import { makeSimTestScope } from './test-utils/with-sim-scope.js';

import type { ChaosConfig } from '../types/base-types.js';

const baseChaos: ChaosConfig = {
  enabled: true,
  probability: 0.5,
  types: [
    {
      type: 'error',
      target: '*',
      probability: 1,
      config: { type: 'error', statusCode: 500, message: 'x' },
    },
  ],
};

beforeEach(() => {
  enterScope(makeSimTestScope());
});

// =============================================================================
// LOAD EXECUTOR — custom execute branch + abort-during-run
// =============================================================================

describe('load executor — custom execute branch', () => {
  it('routes through createCustomExecutor when execute is supplied', async () => {
    let invoked = 0;
    const scenario = defineLoadScenario({
      id: 'load-custom-exec',
      name: 'Load Custom',
      description: 'd',
      tags: [],
      personas: [persona('buyer', 1)],
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate(1)],
      execute: async () => {
        invoked++;
        return {
          passed: true,
          metrics: {
            totalRequests: 100,
            successfulRequests: 100,
            failedRequests: 0,
            avgLatencyMs: 1,
            p50LatencyMs: 1,
            p95LatencyMs: 1,
            p99LatencyMs: 1,
            errorsGenerated: 0,
          },
          assertions: { passed: [], failed: [] },
          signals: [],
        };
      },
    });

    const result = await scenario.run(new AbortController().signal);
    expect(invoked).toBe(1);
    expect(result.kind).toBe('load');
    expect(result.passed).toBe(true);
  });

  it('returns gracefully when load executor aborts mid-run (loop breaks)', async () => {
    const ac = new AbortController();
    const scenario = defineLoadScenario({
      id: 'load-abort-mid',
      name: 'Load Abort Mid',
      description: 'd',
      tags: [],
      personas: [persona('buyer', 1)],
      duration: 60, // long, will be aborted
      assertions: [ASSERTIONS.lowErrorRate(1)],
    });

    setTimeout(() => ac.abort(), 50);
    // Load executor breaks the loop on abort and returns its current state
    // rather than throwing — the surface contract is "graceful exit on abort".
    const result = await scenario.run(ac.signal);
    expect(result.kind).toBe('load');
  });

  it('re-throws non-abort errors from a custom load execute function', async () => {
    const scenario = defineLoadScenario({
      id: 'load-throws',
      name: 'Load Throws',
      description: 'd',
      tags: [],
      personas: [persona('buyer', 1)],
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate(1)],
      execute: async () => {
        // @fitness-ignore-next-line result-pattern-consistency -- intentional throw for test
        throw new Error('custom-load-failure');
      },
    });

    await expect(scenario.run(new AbortController().signal)).rejects.toThrow('custom-load-failure');
  });

  it('converts custom load execute throw into ScenarioAbortedError when signal is aborted', async () => {
    const ac = new AbortController();
    const scenario = defineLoadScenario({
      id: 'load-abort-then-throw',
      name: 'Load Abort Then Throw',
      description: 'd',
      tags: [],
      personas: [persona('buyer', 1)],
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate(1)],
      execute: async () => {
        ac.abort();
        // @fitness-ignore-next-line result-pattern-consistency -- intentional throw mid-run
        throw new Error('custom-throw-after-abort');
      },
    });

    await expect(scenario.run(ac.signal)).rejects.toThrow(ScenarioAbortedError);
  });
});

// =============================================================================
// CHAOS EXECUTOR — abort + error catch
// =============================================================================

describe('chaos executor — abort and error edges', () => {
  it('throws ScenarioAbortedError when called with a pre-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const scenario = defineChaosScenario({
      id: 'chaos-pre-abort',
      name: 'Chaos Pre Abort',
      description: 'd',
      tags: [],
      personas: [persona('buyer', 1)],
      duration: 1,
      chaos: baseChaos,
      steadyStateAssertions: [ASSERTIONS.lowErrorRate(1)],
      recoveryAssertions: [ASSERTIONS.lowErrorRate(1)],
      recoveryWindow: 100,
    });

    await expect(scenario.run(ac.signal)).rejects.toThrow(ScenarioAbortedError);
  });

  it('chaos executor finishes even when aborted mid-run (loop breaks)', async () => {
    const ac = new AbortController();
    const scenario = defineChaosScenario({
      id: 'chaos-abort-mid',
      name: 'Chaos Abort Mid',
      description: 'd',
      tags: [],
      personas: [persona('buyer', 1)],
      duration: 60,
      chaos: baseChaos,
      steadyStateAssertions: [ASSERTIONS.lowErrorRate(1)],
      recoveryAssertions: [ASSERTIONS.lowErrorRate(1)],
      recoveryWindow: 50,
    });

    setTimeout(() => ac.abort(), 30);
    const result = await scenario.run(ac.signal);
    expect(result.kind).toBe('chaos');
  });
});
