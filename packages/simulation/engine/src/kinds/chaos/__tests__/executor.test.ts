/**
 * @fileoverview Behaviour + validation tests for the chaos kind against the
 * real driver + fault model.
 */

import { describe, expect, it } from 'vitest';

import { failingTarget, noopTarget } from '../../../__tests__/test-utils/targets.js';
import { ASSERTIONS } from '../../../framework/assertions.js';
import { fault } from '../../../framework/execution/fault-builders.js';
import { defineChaosScenario, validateChaosScenarioConfig } from '../define.js';
import { createChaosScenarioRunner } from '../executor.js';

import type { ChaosScenarioConfig } from '../config.js';

const base = (o: Partial<ChaosScenarioConfig> = {}): ChaosScenarioConfig => ({
  id: 'c',
  name: 'c',
  description: 'c',
  tags: [],
  target: noopTarget,
  workload: { rps: 50 },
  duration: 0.3,
  fault: fault.of([fault.drop()], { probability: 1 }),
  steadyStateAssertions: [ASSERTIONS.lowErrorRate(0.5)],
  recoveryAssertions: [ASSERTIONS.lowErrorRate(0.5)],
  recoveryWindowMs: 100,
  ...o,
});

describe('chaos executor', () => {
  it('faults degrade the steady window; recovery recovers', async () => {
    const r = await createChaosScenarioRunner(base()).run(new AbortController().signal);
    if (r.kind !== 'chaos') throw new Error('expected chaos result');
    // probability-1 drop → all steady requests fail; recovery (bare noop) succeeds.
    expect(r.outcome.steadyStateMetrics.failedRequests).toBeGreaterThan(0);
    expect(r.outcome.steadyStateMetrics.successfulRequests).toBe(0);
    expect(r.outcome.steadyStateAssertions.failed.length).toBeGreaterThan(0);
    expect(r.outcome.recoveryMetrics.successfulRequests).toBeGreaterThan(0);
    expect(r.outcome.recoveryAssertions.failed).toHaveLength(0);
    expect(r.passed).toBe(false);
    expect(r.outcome.chaosEvents.length).toBeGreaterThan(0);
    expect(r.outcome.chaosEvents[0]?.type).toBe('drop');
    expect(r.outcome.recoveryWindowMs).toBe(100);
  });

  it('passes when both windows hold (no faults injected)', async () => {
    const r = await createChaosScenarioRunner(
      base({ fault: fault.of([fault.drop()], { probability: 0 }) }),
    ).run(new AbortController().signal);
    if (r.kind !== 'chaos') throw new Error('expected chaos result');
    expect(r.passed).toBe(true);
    expect(r.outcome.chaosEvents).toHaveLength(0);
  });

  it('fails recovery when the target never recovers', async () => {
    const r = await createChaosScenarioRunner(
      base({
        target: failingTarget,
        fault: fault.of([fault.drop()], { probability: 0 }),
        steadyStateAssertions: [ASSERTIONS.lowErrorRate(1)],
        recoveryAssertions: [ASSERTIONS.lowErrorRate(0.1)],
      }),
    ).run(new AbortController().signal);
    if (r.kind !== 'chaos') throw new Error('expected chaos result');
    expect(r.outcome.recoveryAssertions.failed.length).toBeGreaterThan(0);
    expect(r.passed).toBe(false);
  });

  it('honours an injected rng deterministically (no perturbation)', async () => {
    const r = await createChaosScenarioRunner(
      base({ fault: fault.of([fault.drop()], { probability: 0.5 }) }),
      { rng: () => 0.9 },
    ).run(new AbortController().signal);
    if (r.kind !== 'chaos') throw new Error('expected chaos result');
    // rng always 0.9 ≥ 0.5 ⇒ never perturb.
    expect(r.outcome.chaosEvents).toHaveLength(0);
    expect(r.outcome.steadyStateMetrics.failedRequests).toBe(0);
  });

  it('throws on a pre-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(createChaosScenarioRunner(base()).run(ac.signal)).rejects.toThrow(/abort/i);
  });
});

describe('validateChaosScenarioConfig', () => {
  it('accepts a valid config via defineChaosScenario', () => {
    expect(defineChaosScenario(base()).kind).toBe('chaos');
  });
  it('rejects a non-function target', () => {
    expect(() => validateChaosScenarioConfig(base({ target: undefined as never }))).toThrow(
      /target/,
    );
  });
  it('rejects a probability outside [0,1]', () => {
    expect(() =>
      validateChaosScenarioConfig(base({ fault: fault.of([fault.drop()], { probability: 2 }) })),
    ).toThrow(/probability/);
  });
  it('rejects an empty faults array', () => {
    expect(() =>
      validateChaosScenarioConfig(base({ fault: { faults: [], probability: 0.5 } })),
    ).toThrow(/faults/);
  });
  it('rejects a non-positive rps', () => {
    expect(() => validateChaosScenarioConfig(base({ workload: { rps: 0 } }))).toThrow(/rps/);
  });
  it('rejects empty steady-state assertions', () => {
    expect(() => validateChaosScenarioConfig(base({ steadyStateAssertions: [] }))).toThrow(
      /steady/i,
    );
  });
  it('rejects empty recovery assertions', () => {
    expect(() => validateChaosScenarioConfig(base({ recoveryAssertions: [] }))).toThrow(
      /recovery assertion/i,
    );
  });
  it('rejects an invalid recoveryWindowMs (negative / non-number)', () => {
    expect(() => validateChaosScenarioConfig(base({ recoveryWindowMs: -1 }))).toThrow(
      /recoveryWindowMs/,
    );
    expect(() => validateChaosScenarioConfig(base({ recoveryWindowMs: 'soon' as never }))).toThrow(
      /recoveryWindowMs/,
    );
  });
  it('rejects a negative rampUp', () => {
    expect(() => validateChaosScenarioConfig(base({ workload: { rps: 1, rampUp: -1 } }))).toThrow(
      /rampUp must be non-negative/,
    );
  });
  it('rejects a non-positive duration', () => {
    expect(() => validateChaosScenarioConfig(base({ duration: 0 }))).toThrow(/duration/);
  });
  it('rejects a missing fault spec', () => {
    expect(() => validateChaosScenarioConfig(base({ fault: undefined as never }))).toThrow(
      /fault spec is required/,
    );
  });
  it('rejects an unknown fault kind', () => {
    expect(() =>
      validateChaosScenarioConfig(
        base({
          fault: { faults: [{ kind: 'meltdown' as never }], probability: 0.5 },
        }),
      ),
    ).toThrow(/fault kind must be one of/);
  });
  it('rejects a latency fault with a missing or negative ms', () => {
    expect(() =>
      validateChaosScenarioConfig(
        base({
          fault: { faults: [{ kind: 'latency' } as never], probability: 0.5 },
        }),
      ),
    ).toThrow(/latency fault requires a non-negative ms/);
    expect(() =>
      validateChaosScenarioConfig(
        base({
          fault: {
            faults: [{ kind: 'latency', ms: -5 } as never],
            probability: 0.5,
          },
        }),
      ),
    ).toThrow(/latency fault requires a non-negative ms/);
  });
});
