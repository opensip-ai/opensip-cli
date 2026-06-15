/**
 * @fileoverview Integration tests that run scenarios end-to-end so the
 * execution-engine + per-kind executor paths are exercised. Each
 * scenario uses a tiny duration so the test runs quickly.
 *
 * This file focuses on actually running the executor for the load and
 * chaos kinds.
 */

import { enterScope } from '@opensip-cli/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { ASSERTIONS } from '../framework/assertions.js';
import { fault } from '../framework/execution/fault-builders.js';
import { ScenarioAbortedError } from '../framework/execution/scenario-aborted-error.js';
import { defineChaosScenario } from '../kinds/chaos/define.js';
import { defineLoadScenario } from '../kinds/load/define.js';

import { makeSimTestScope } from './test-utils/with-sim-scope.js';

const noopTarget = (): Promise<void> => Promise.resolve();

beforeEach(() => {
  // Item 1: scenarioRegistry is per-RunScope. Enter a fresh scope.
  enterScope(makeSimTestScope());
});

describe('Load scenario execution', () => {
  it('runs to completion and returns a load-kind result', async () => {
    const scenario = defineLoadScenario({
      id: 'load-exec-1',
      name: 'load-exec-1',
      description: 'tiny load run',
      tags: [],
      target: noopTarget,
      workload: { rps: 1 },
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
      target: noopTarget,
      workload: { rps: 1 },
      duration: 5,
      assertions: [ASSERTIONS.lowErrorRate(1)],
    });

    const ac = new AbortController();
    ac.abort();
    await expect(scenario.run(ac.signal)).rejects.toThrow(ScenarioAbortedError);
  });

  it('honors an explicit workload rps + concurrency', async () => {
    const scenario = defineLoadScenario({
      id: 'load-targetrps',
      name: 'load-targetrps',
      description: 'load with explicit RPS',
      tags: [],
      target: noopTarget,
      workload: { rps: 10, concurrency: 4 },
      duration: 1,
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
      target: noopTarget,
      workload: { rps: 1 },
      duration: 1,
      fault: fault.of([fault.drop()], { probability: 0.1 }),
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
