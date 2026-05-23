/**
 * @fileoverview Unit tests for execution-engine utilities.
 *
 * The orchestration loop is exercised by scenario-execution.test.ts;
 * this file targets the helper functions that are exported as the
 * public API of the engine.
 */

import { describe, expect, it } from 'vitest';

import { resolveMetric } from '../../resolve-metric.js';
import { createEmptyMetrics } from '../../result-builder.js';
import {
  ScenarioAbortedError,
  scenarioAborted,
  sleepWithAbort,
  updateLatencyMetrics,
  validateAssertions,
} from '../execution-engine.js';

import type { SimulationMetrics, ScenarioAssertion } from '../../../types/base-types.js';

const baseMetrics = (overrides: Partial<SimulationMetrics> = {}): SimulationMetrics => ({
  ...createEmptyMetrics(),
  totalRequests: 100,
  successfulRequests: 99,
  failedRequests: 1,
  avgLatencyMs: 50,
  p50LatencyMs: 40,
  p95LatencyMs: 80,
  p99LatencyMs: 120,
  ...overrides,
});

describe('validateAssertions', () => {
  it('returns passed=true when every assertion holds', () => {
    const assertions: ScenarioAssertion[] = [
      { metric: 'error_rate', operator: 'lt', value: 0.5, message: 'low error rate' },
      { metric: 'success_rate', operator: 'gt', value: 0.5, message: 'high success rate' },
    ];
    const out = validateAssertions(baseMetrics(), assertions);
    expect(out.passed).toBe(true);
    expect(out.failed).toEqual([]);
  });

  it('returns failed entries with the actual value', () => {
    const assertions: ScenarioAssertion[] = [
      { metric: 'error_rate', operator: 'lt', value: 0.001, message: 'extreme low error' },
    ];
    const out = validateAssertions(baseMetrics(), assertions);
    expect(out.passed).toBe(false);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0]?.actual).toBeCloseTo(0.01);
  });

  it('returns passed=false / failed=[] when assertions is not an array', () => {
    const out = validateAssertions(baseMetrics(), undefined as unknown as ScenarioAssertion[]);
    expect(out.passed).toBe(false);
    expect(out.failed).toEqual([]);
  });

  it('honors an empty assertion list as passing', () => {
    expect(validateAssertions(baseMetrics(), []).passed).toBe(true);
  });
});

describe('resolveMetric (via validateAssertions)', () => {
  it.each([
    ['error_rate', baseMetrics({ totalRequests: 100, failedRequests: 25 }), 0.25],
    ['error_rate', baseMetrics({ totalRequests: 0 }), 0],
    ['success_rate', baseMetrics({ totalRequests: 100, successfulRequests: 90 }), 0.9],
    // Per resolve-metric.ts: success_rate is 0 when totalRequests === 0 (tightening choice).
    ['success_rate', baseMetrics({ totalRequests: 0 }), 0],
    ['recovery_rate', baseMetrics({ errorsGenerated: 10, failedRequests: 2 }), 0.8],
    ['recovery_rate', baseMetrics({ errorsGenerated: 0 }), 1],
    ['p50_latency', baseMetrics({ p50LatencyMs: 40 }), 40],
    ['p50_latency_ms', baseMetrics({ p50LatencyMs: 40 }), 40],
    ['p95_latency_ms', baseMetrics({ p95LatencyMs: 80 }), 80],
    ['p99_latency_ms', baseMetrics({ p99LatencyMs: 120 }), 120],
    ['avg_latency_ms', baseMetrics({ avgLatencyMs: 60 }), 60],
    ['total_requests', baseMetrics({ totalRequests: 5 }), 5],
    ['failed_requests', baseMetrics({ failedRequests: 3 }), 3],
    ['findings_generated', baseMetrics({ findingsGenerated: 2 }), 2],
  ] as const)('resolveMetric(%s)', (metric, metrics, expected) => {
    expect(resolveMetric(metric, metrics)).toBeCloseTo(expected);
  });
});

describe('updateLatencyMetrics', () => {
  it('seeds all percentile fields on the first sample', () => {
    const m = createEmptyMetrics();
    updateLatencyMetrics(m, 100);
    expect(m.avgLatencyMs).toBe(100);
    expect(m.p50LatencyMs).toBe(100);
    expect(m.p95LatencyMs).toBe(100);
    expect(m.p99LatencyMs).toBe(100);
  });

  it('updates the running average on subsequent samples', () => {
    const m: SimulationMetrics = { ...createEmptyMetrics(), totalRequests: 1, avgLatencyMs: 100 };
    // After: n=1, avg becomes (100*0 + sample)/1 — but the function expects
    // `metrics.totalRequests` to be the count BEFORE incrementing.
    updateLatencyMetrics(m, 200);
    expect(m.avgLatencyMs).toBe(200);
  });

  it('approximates percentiles as multiples of the average for n>=1', () => {
    const m: SimulationMetrics = { ...createEmptyMetrics(), totalRequests: 2, avgLatencyMs: 100 };
    updateLatencyMetrics(m, 200);
    expect(m.p50LatencyMs).toBeCloseTo(m.avgLatencyMs * 0.9);
    expect(m.p95LatencyMs).toBeCloseTo(m.avgLatencyMs * 1.5);
    expect(m.p99LatencyMs).toBeCloseTo(m.avgLatencyMs * 2);
  });
});

describe('sleepWithAbort', () => {
  it('resolves after the specified delay', async () => {
    const ac = new AbortController();
    const start = Date.now();
    await sleepWithAbort(20, ac.signal);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(sleepWithAbort(1000, ac.signal)).rejects.toThrow(ScenarioAbortedError);
  });

  it('rejects when the signal is aborted mid-sleep', async () => {
    const ac = new AbortController();
    const promise = sleepWithAbort(10_000, ac.signal);
    setTimeout(() => ac.abort(), 5);
    await expect(promise).rejects.toThrow(ScenarioAbortedError);
  });
});

describe('scenarioAborted', () => {
  it('returns silently when signal is undefined', () => {
    expect(() => scenarioAborted(undefined)).not.toThrow();
  });

  it('returns silently when signal is not aborted', () => {
    const ac = new AbortController();
    expect(() => scenarioAborted(ac.signal)).not.toThrow();
  });

  it('throws ScenarioAbortedError when signal is aborted', () => {
    const ac = new AbortController();
    ac.abort();
    expect(() => scenarioAborted(ac.signal, 'sid')).toThrow(ScenarioAbortedError);
  });
});

describe('ScenarioAbortedError', () => {
  it('carries the scenario id when one is supplied', () => {
    const err = new ScenarioAbortedError('s1');
    expect(err.message).toContain('s1');
  });

  it('uses an unknown placeholder when no id is supplied', () => {
    const err = new ScenarioAbortedError();
    expect(err.message.length).toBeGreaterThan(0);
  });
});
