import { ValidationError, createSignal } from '@opensip-tools/core';
import { describe, expect, it } from 'vitest';

import { ASSERTIONS } from '../assertions.js';
import { ScenarioResultBuilder, createEmptyMetrics, mergeMetrics } from '../result-builder.js';

import type { SimulationMetrics } from '../../types/base-types.js';

const baseMetrics = (overrides: Partial<SimulationMetrics> = {}): SimulationMetrics => ({
  ...createEmptyMetrics(),
  totalRequests: 100,
  successfulRequests: 99,
  failedRequests: 1,
  avgLatencyMs: 50,
  p50LatencyMs: 40,
  p95LatencyMs: 80,
  p99LatencyMs: 120,
  errorsGenerated: 0,
  ...overrides,
});

const sig = (overrides: Partial<Parameters<typeof createSignal>[0]> = {}) =>
  createSignal({
    source: 'simulation',
    provider: 'opensip',
    severity: 'medium',
    category: 'warning',
    ruleId: 'sim:test',
    message: 'note',
    ...overrides,
  });

describe('ScenarioResultBuilder', () => {
  it('returns scenario id', () => {
    expect(ScenarioResultBuilder.create('s1').getScenarioId()).toBe('s1');
  });

  it('builds a passed payload when all assertions hold', () => {
    const out = ScenarioResultBuilder.create('s1')
      .withMetrics(baseMetrics())
      .withDuration(10)
      .evaluateAssertions([ASSERTIONS.lowErrorRate(), ASSERTIONS.highSuccessRate(0.9)])
      .build();
    expect(out.passed).toBe(true);
    expect(out.assertions.passed).toHaveLength(2);
    expect(out.assertions.failed).toEqual([]);
  });

  it('records failed assertion with the actual value', () => {
    const out = ScenarioResultBuilder.create('s1')
      .withMetrics(baseMetrics({ failedRequests: 50 }))
      .evaluateAssertions([ASSERTIONS.lowErrorRate()])
      .build();
    expect(out.passed).toBe(false);
    expect(out.assertions.failed).toHaveLength(1);
    expect(out.assertions.failed[0]?.actual).toBeCloseTo(0.5);
  });

  it('throws when evaluating assertions before metrics are set', () => {
    expect(() =>
      ScenarioResultBuilder.create('s1').evaluateAssertions([ASSERTIONS.lowErrorRate()]),
    ).toThrow(ValidationError);
  });

  it('throws on build() when metrics are not set', () => {
    expect(() => ScenarioResultBuilder.create('s1').build()).toThrow(ValidationError);
  });

  it('addSignal / addSignals propagate to the payload', () => {
    const out = ScenarioResultBuilder.create('s1')
      .withMetrics(baseMetrics())
      .addSignal(sig({ ruleId: 'sim:a' }))
      .addSignals([sig({ ruleId: 'sim:b' }), sig({ ruleId: 'sim:c' })])
      .build();
    expect(out.signals.map((s) => s.ruleId)).toEqual(['sim:a', 'sim:b', 'sim:c']);
  });

  it('assertionPassed / assertionFailed allow manual record-keeping', () => {
    const a = ASSERTIONS.lowErrorRate();
    const out = ScenarioResultBuilder.create('s1')
      .withMetrics(baseMetrics())
      .assertionPassed(a)
      .assertionFailed(a, 0.99)
      .build();
    expect(out.assertions.passed).toHaveLength(1);
    expect(out.assertions.failed).toHaveLength(1);
  });

  describe('metric resolution', () => {
    it('resolves error_rate from totalRequests / failedRequests', () => {
      const out = ScenarioResultBuilder.create('s1')
        .withMetrics(baseMetrics({ totalRequests: 200, failedRequests: 10 }))
        .evaluateAssertions([ASSERTIONS.lowErrorRate(0.1)])
        .build();
      expect(out.passed).toBe(true);
    });

    it('resolves error_rate to 0 when totalRequests is 0', () => {
      const out = ScenarioResultBuilder.create('s1')
        .withMetrics(baseMetrics({ totalRequests: 0, failedRequests: 0 }))
        .evaluateAssertions([ASSERTIONS.lowErrorRate()])
        .build();
      expect(out.passed).toBe(true);
    });

    it('resolves success_rate from successful / total', () => {
      const out = ScenarioResultBuilder.create('s1')
        .withMetrics(baseMetrics({ totalRequests: 100, successfulRequests: 100 }))
        .evaluateAssertions([ASSERTIONS.perfectSuccessRate()])
        .build();
      expect(out.passed).toBe(true);
    });

    it('success_rate is 0 when no requests', () => {
      const out = ScenarioResultBuilder.create('s1')
        .withMetrics(baseMetrics({ totalRequests: 0 }))
        .evaluateAssertions([ASSERTIONS.highSuccessRate(0.5)])
        .build();
      expect(out.passed).toBe(false);
    });

    it('resolves requests_per_second from totalRequests / duration', () => {
      const out = ScenarioResultBuilder.create('s1')
        .withMetrics(baseMetrics({ totalRequests: 100 }))
        .withDuration(10)
        .evaluateAssertions([ASSERTIONS.minThroughput(5)])
        .build();
      expect(out.passed).toBe(true); // 10 RPS >= 5
    });

    it('requests_per_second is 0 without duration', () => {
      const out = ScenarioResultBuilder.create('s1')
        .withMetrics(baseMetrics())
        .evaluateAssertions([ASSERTIONS.minThroughput(1)])
        .build();
      expect(out.passed).toBe(false);
    });

    it('resolves direct latency fields from metrics', () => {
      const out = ScenarioResultBuilder.create('s1')
        .withMetrics(baseMetrics({ p95LatencyMs: 200 }))
        .evaluateAssertions([ASSERTIONS.lowLatency('p95', 300)])
        .build();
      expect(out.passed).toBe(true);
    });

    it('returns 0 for unknown metrics', () => {
      const out = ScenarioResultBuilder.create('s1')
        .withMetrics(baseMetrics())
        .evaluateAssertions([ASSERTIONS.custom('cpu_percent', 'lt', 100)])
        .build();
      expect(out.passed).toBe(true); // 0 < 100
    });
  });
});

describe('createEmptyMetrics', () => {
  it('returns a zero-valued metrics object', () => {
    const m = createEmptyMetrics();
    expect(m.totalRequests).toBe(0);
    expect(m.successfulRequests).toBe(0);
    expect(m.failedRequests).toBe(0);
    expect(m.avgLatencyMs).toBe(0);
  });
});

describe('mergeMetrics', () => {
  it('returns empty metrics for an empty list', () => {
    expect(mergeMetrics([])).toEqual(createEmptyMetrics());
  });

  it('returns the single entry directly', () => {
    const only = baseMetrics();
    expect(mergeMetrics([only])).toBe(only);
  });

  it('sums totals and weights average latency', () => {
    const a = baseMetrics({ totalRequests: 100, successfulRequests: 100, failedRequests: 0, avgLatencyMs: 50 });
    const b = baseMetrics({ totalRequests: 100, successfulRequests: 50, failedRequests: 50, avgLatencyMs: 150 });
    const merged = mergeMetrics([a, b]);
    expect(merged.totalRequests).toBe(200);
    expect(merged.successfulRequests).toBe(150);
    expect(merged.failedRequests).toBe(50);
    expect(merged.avgLatencyMs).toBeCloseTo(100); // weighted by totalRequests
  });

  it('takes the max for percentile latencies', () => {
    const a = baseMetrics({ p99LatencyMs: 100 });
    const b = baseMetrics({ p99LatencyMs: 250 });
    expect(mergeMetrics([a, b]).p99LatencyMs).toBe(250);
  });

  it('returns 0 average latency when totalRequests is 0', () => {
    const a = baseMetrics({ totalRequests: 0, avgLatencyMs: 100 });
    const b = baseMetrics({ totalRequests: 0, avgLatencyMs: 200 });
    expect(mergeMetrics([a, b]).avgLatencyMs).toBe(0);
  });
});
