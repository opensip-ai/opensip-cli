/**
 * @fileoverview ADR-0035 gate precondition: a failed sim scenario must surface
 * an error-severity signal (the signal currency), for BOTH kinds — load (via
 * the result builder) and chaos (which builds its own payload). Before this,
 * a failing run had `passed: false` but `signals: []`, so the host verdict
 * computed `errors === 0` and would flip the run to PASS. These tests pin the
 * fix against the real executors.
 */

import { isErrorSignal } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { ASSERTIONS } from '../framework/assertions.js';
import { fault } from '../framework/execution/fault-builders.js';
import { buildFailedScenarioSignal } from '../framework/result-builder.js';
import { createChaosScenarioRunner } from '../kinds/chaos/executor.js';
import { createLoadScenarioRunner } from '../kinds/load/executor.js';

import { failingTarget, noopTarget } from './test-utils/targets.js';

import type { ChaosScenarioConfig } from '../kinds/chaos/config.js';
import type { LoadScenarioConfig } from '../kinds/load/config.js';

const loadCfg = (o: Partial<LoadScenarioConfig> = {}): LoadScenarioConfig => ({
  id: 'load-x',
  name: 'load-x',
  description: 'load-x',
  tags: [],
  target: noopTarget,
  workload: { rps: 50 },
  duration: 0.3,
  assertions: [ASSERTIONS.lowErrorRate(0.5)],
  ...o,
});

const chaosCfg = (o: Partial<ChaosScenarioConfig> = {}): ChaosScenarioConfig => ({
  id: 'chaos-x',
  name: 'chaos-x',
  description: 'chaos-x',
  tags: [],
  target: noopTarget,
  workload: { rps: 50 },
  duration: 0.3,
  fault: fault.of([fault.drop()], { probability: 1 }),
  steadyStateAssertions: [ASSERTIONS.lowErrorRate(0.1)],
  recoveryAssertions: [ASSERTIONS.lowErrorRate(0.5)],
  recoveryWindowMs: 100,
  ...o,
});

describe('ADR-0035 · failed scenario emits an error-severity signal', () => {
  it('load: a failing scenario emits ≥1 error signal attributed to its id', async () => {
    const r = await createLoadScenarioRunner(
      loadCfg({
        target: failingTarget,
        assertions: [ASSERTIONS.lowErrorRate(0.1)],
      }),
    ).run(new AbortController().signal);
    if (r.kind !== 'load') throw new Error('expected load result');

    expect(r.passed).toBe(false);
    const errors = r.signals.filter(isErrorSignal);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]?.source).toBe('load-x');
  });

  it('load: a passing scenario emits no error signal', async () => {
    const r = await createLoadScenarioRunner(loadCfg()).run(new AbortController().signal);
    if (r.kind !== 'load') throw new Error('expected load result');

    expect(r.passed).toBe(true);
    expect(r.signals.filter(isErrorSignal)).toHaveLength(0);
  });

  it('chaos: a failing scenario emits ≥1 error signal attributed to its id', async () => {
    const r = await createChaosScenarioRunner(chaosCfg()).run(new AbortController().signal);
    if (r.kind !== 'chaos') throw new Error('expected chaos result');

    expect(r.passed).toBe(false);
    const errors = r.signals.filter(isErrorSignal);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0]?.source).toBe('chaos-x');
  });

  it('chaos: a passing scenario (no faults) emits no error signal', async () => {
    const r = await createChaosScenarioRunner(
      chaosCfg({ fault: fault.of([fault.drop()], { probability: 0 }) }),
    ).run(new AbortController().signal);
    if (r.kind !== 'chaos') throw new Error('expected chaos result');

    expect(r.passed).toBe(true);
    expect(r.signals.filter(isErrorSignal)).toHaveLength(0);
  });

  it('buildFailedScenarioSignal: high severity, scenario-attributed, summarizes assertions', () => {
    const sig = buildFailedScenarioSignal('s1', [
      {
        metric: 'error_rate',
        operator: 'lte',
        value: 0.1,
        message: 'low errors',
        actual: 0.9,
      },
    ]);
    expect(sig.severity).toBe('high');
    expect(isErrorSignal(sig)).toBe(true);
    expect(sig.source).toBe('s1');
    expect(sig.message).toContain('error_rate');
    expect(sig.message).toContain('0.9');
  });
});
