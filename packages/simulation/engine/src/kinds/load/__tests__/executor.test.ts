/**
 * @fileoverview Behaviour + validation tests for the load kind against the
 * real driver.
 */

import { describe, expect, it } from 'vitest';

import {
  countingTarget,
  failingTarget,
  noopTarget,
} from '../../../__tests__/test-utils/targets.js';
import { ASSERTIONS } from '../../../framework/assertions.js';
import { defineLoadScenario, validateLoadScenarioConfig } from '../define.js';
import { createLoadScenarioRunner } from '../executor.js';

import type { LoadScenarioConfig } from '../config.js';

const base = (o: Partial<LoadScenarioConfig> = {}): LoadScenarioConfig => ({
  id: 'l',
  name: 'l',
  description: 'l',
  tags: [],
  target: noopTarget,
  workload: { rps: 50 },
  duration: 0.3,
  assertions: [ASSERTIONS.lowErrorRate(0.5)],
  ...o,
});

describe('load executor', () => {
  it('drives the target in a sustained loop (many requests, not one)', async () => {
    const ct = countingTarget();
    const r = await createLoadScenarioRunner(
      base({ target: ct.target, workload: { rps: 100 } }),
    ).run(new AbortController().signal);
    if (r.kind !== 'load') throw new Error('expected load result');
    expect(r.outcome.metrics.totalRequests).toBeGreaterThan(5);
    expect(ct.calls()).toBe(r.outcome.metrics.totalRequests);
  });

  it('passes when the target succeeds', async () => {
    const r = await createLoadScenarioRunner(base()).run(new AbortController().signal);
    if (r.kind !== 'load') throw new Error('expected load result');
    expect(r.passed).toBe(true);
  });

  it('fails when the target fails', async () => {
    const r = await createLoadScenarioRunner(
      base({ target: failingTarget, assertions: [ASSERTIONS.lowErrorRate(0.1)] }),
    ).run(new AbortController().signal);
    if (r.kind !== 'load') throw new Error('expected load result');
    expect(r.passed).toBe(false);
  });

  it('throws on a pre-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(createLoadScenarioRunner(base()).run(ac.signal)).rejects.toThrow(/abort/i);
  });
});

describe('validateLoadScenarioConfig', () => {
  it('accepts a valid config via defineLoadScenario', () => {
    expect(defineLoadScenario(base()).kind).toBe('load');
  });
  it('rejects a non-function target', () => {
    expect(() => validateLoadScenarioConfig(base({ target: undefined as never }))).toThrow(
      /target/,
    );
  });
  it('rejects a non-positive rps', () => {
    expect(() => validateLoadScenarioConfig(base({ workload: { rps: 0 } }))).toThrow(/rps/);
  });
  it('rejects rampUp greater than duration', () => {
    expect(() =>
      validateLoadScenarioConfig(base({ duration: 1, workload: { rps: 1, rampUp: 5 } })),
    ).toThrow(/rampUp/);
  });
  it('rejects a negative rampUp (non-negative shape check)', () => {
    expect(() => validateLoadScenarioConfig(base({ workload: { rps: 1, rampUp: -1 } }))).toThrow(
      /rampUp must be a non-negative number/,
    );
  });
  it('rejects a non-number rampUp', () => {
    expect(() =>
      validateLoadScenarioConfig(base({ workload: { rps: 1, rampUp: 'soon' as never } })),
    ).toThrow(/rampUp must be a non-negative number/);
  });
  it('rejects a non-positive duration', () => {
    expect(() => validateLoadScenarioConfig(base({ duration: 0 }))).toThrow(/duration/);
    expect(() => validateLoadScenarioConfig(base({ duration: 'x' as never }))).toThrow(/duration/);
  });
  it('rejects empty assertions', () => {
    expect(() => validateLoadScenarioConfig(base({ assertions: [] }))).toThrow(/assertion/);
  });
});
