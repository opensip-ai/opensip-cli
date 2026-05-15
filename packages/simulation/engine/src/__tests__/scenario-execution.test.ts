/**
 * @fileoverview Integration tests that run scenarios end-to-end so the
 * execution-engine + per-kind executor paths are exercised. Each
 * scenario uses a tiny duration so the test runs quickly.
 *
 * Invariant and fix-evaluation kinds have stricter validation
 * requirements (relatesToInvariant doc anchor + signal payload + async
 * setup) that are tested in their dedicated define-*.test.ts files;
 * this file focuses on actually running the executor for the simpler
 * load and chaos kinds.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { ASSERTIONS } from '../framework/assertions.js';
import { ScenarioAbortedError } from '../framework/execution/scenario-aborted-error.js';
import { persona } from '../framework/personas.js';
import { clearScenarioRegistry } from '../framework/registry.js';
import { defineChaosScenario } from '../kinds/chaos/define.js';
import { defineLoadScenario } from '../kinds/load/define.js';

afterEach(() => {
  clearScenarioRegistry();
});

describe('Load scenario execution', () => {
  it('runs to completion and returns a load-kind result', async () => {
    const scenario = defineLoadScenario({
      id: 'load-exec-1',
      name: 'load-exec-1',
      description: 'tiny load run',
      tags: [],
      personas: [persona('user', 1, { spawnRate: 1 })],
      duration: 1,
      assertions: [ASSERTIONS.lowErrorRate(1)],
    });

    const result = await scenario.run(new AbortController().signal);
    expect(result.kind).toBe('load');
    expect(result.scenarioId).toBe('load-exec-1');
    expect(typeof result.passed).toBe('boolean');
    expect(typeof result.durationMs).toBe('number');
  });

  it('throws ScenarioAbortedError on a pre-aborted signal', async () => {
    const scenario = defineLoadScenario({
      id: 'load-exec-aborted',
      name: 'load-exec-aborted',
      description: 'aborted',
      tags: [],
      personas: [persona('user', 1, { spawnRate: 1 })],
      duration: 5,
      assertions: [ASSERTIONS.lowErrorRate(1)],
    });

    const ac = new AbortController();
    ac.abort();
    await expect(scenario.run(ac.signal)).rejects.toThrow(ScenarioAbortedError);
  });

  it('honors a target RPS when set', async () => {
    const scenario = defineLoadScenario({
      id: 'load-targetrps',
      name: 'load-targetrps',
      description: 'load with explicit RPS',
      tags: [],
      personas: [persona('user', 2, { spawnRate: 1 })],
      duration: 1,
      targetRps: 10,
      assertions: [ASSERTIONS.lowErrorRate(1)],
    });

    const result = await scenario.run(new AbortController().signal);
    expect(result.kind).toBe('load');
    expect(typeof result.passed).toBe('boolean');
  });
});

describe('Chaos scenario execution', () => {
  it('runs to completion and returns a chaos-kind result', async () => {
    const scenario = defineChaosScenario({
      id: 'chaos-exec-1',
      name: 'chaos-exec-1',
      description: 'tiny chaos run',
      tags: [],
      personas: [persona('user', 1, { spawnRate: 1 })],
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
      recoveryAssertions: [ASSERTIONS.lowErrorRate(1)],
      recoveryWindow: 100,
    });

    const result = await scenario.run(new AbortController().signal);
    expect(result.kind).toBe('chaos');
    expect(result.scenarioId).toBe('chaos-exec-1');
    expect(typeof result.passed).toBe('boolean');
  });
});
