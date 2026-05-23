import { describe, expect, it } from 'vitest';

import {
  ASSERTIONS,
  evaluateAssertion,
  evaluateOperator,
  getOperatorDescription,
} from '../assertions.js';

import type { ScenarioAssertion } from '../../types/framework-types.js';

describe('ASSERTIONS factories', () => {
  it.each([
    ['lowErrorRate', () => ASSERTIONS.lowErrorRate(), 'error_rate', 'lt', 0.05],
    ['lowErrorRate(custom)', () => ASSERTIONS.lowErrorRate(0.01), 'error_rate', 'lt', 0.01],
    ['zeroErrors', () => ASSERTIONS.zeroErrors(), 'error_rate', 'eq', 0],
    ['lowLatency(default)', () => ASSERTIONS.lowLatency(), 'p95_latency_ms', 'lt', 500],
    ['lowLatency(p99,1000)', () => ASSERTIONS.lowLatency('p99', 1000), 'p99_latency_ms', 'lt', 1000],
    ['avgLatency', () => ASSERTIONS.avgLatency(), 'avg_latency_ms', 'lt', 200],
    ['avgLatency(custom)', () => ASSERTIONS.avgLatency(50), 'avg_latency_ms', 'lt', 50],
    ['maxLatency', () => ASSERTIONS.maxLatency(), 'max_latency_ms', 'lt', 2000],
    ['maxLatency(custom)', () => ASSERTIONS.maxLatency(5000), 'max_latency_ms', 'lt', 5000],
    ['minThroughput', () => ASSERTIONS.minThroughput(100), 'requests_per_second', 'gte', 100],
    ['maxThroughput', () => ASSERTIONS.maxThroughput(50), 'requests_per_second', 'lte', 50],
    ['highSuccessRate(default)', () => ASSERTIONS.highSuccessRate(), 'success_rate', 'gte', 0.95],
    ['highSuccessRate(custom)', () => ASSERTIONS.highSuccessRate(0.99), 'success_rate', 'gte', 0.99],
    ['perfectSuccessRate', () => ASSERTIONS.perfectSuccessRate(), 'success_rate', 'eq', 1],
    ['memoryUsage', () => ASSERTIONS.memoryUsage(512), 'memory_mb', 'lt', 512],
    ['cpuUsage', () => ASSERTIONS.cpuUsage(80), 'cpu_percent', 'lt', 80],
  ])('%s produces expected ScenarioAssertion', (_name, factory, metric, operator, value) => {
    const a = factory();
    expect(a.metric).toBe(metric);
    expect(a.operator).toBe(operator);
    expect(a.value).toBe(value);
    expect(typeof a.message).toBe('string');
    expect((a.message ?? '').length).toBeGreaterThan(0);
  });

  it('custom() builds an assertion with a user-supplied metric', () => {
    const a = ASSERTIONS.custom('total_requests', 'gt', 42, 'total_requests must be > 42');
    expect(a.metric).toBe('total_requests');
    expect(a.operator).toBe('gt');
    expect(a.value).toBe(42);
    expect(a.message).toBe('total_requests must be > 42');
  });

  it('custom() defaults the message when omitted', () => {
    const a = ASSERTIONS.custom('p50_latency_ms', 'lt', 100);
    expect(a.message).toBe('p50_latency_ms lt 100');
  });
});

describe('evaluateOperator', () => {
  it.each<[number, string, number, boolean]>([
    [1, 'lt', 2, true],
    [2, 'lt', 2, false],
    [2, 'lte', 2, true],
    [3, 'lte', 2, false],
    [3, 'gt', 2, true],
    [2, 'gt', 2, false],
    [2, 'gte', 2, true],
    [1, 'gte', 2, false],
    [5, 'eq', 5, true],
    [5, 'eq', 6, false],
    [5, 'neq', 6, true],
    [5, 'neq', 5, false],
  ])('evaluateOperator(%d, %s, %d) === %s', (a, op, b, expected) => {
    expect(evaluateOperator(a, op as Parameters<typeof evaluateOperator>[1], b)).toBe(expected);
  });

  it('returns false for unknown operators', () => {
    expect(evaluateOperator(1, 'unknown' as Parameters<typeof evaluateOperator>[1], 2)).toBe(false);
  });
});

describe('evaluateAssertion', () => {
  const make = (operator: ScenarioAssertion['operator'], value: number): ScenarioAssertion => ({
    metric: 'error_rate',
    operator,
    value,
    message: 'x',
  });

  it.each<[ScenarioAssertion['operator'], number, number, boolean]>([
    ['lt', 5, 3, true],
    ['lt', 5, 5, false],
    ['lte', 5, 5, true],
    ['lte', 5, 6, false],
    ['gt', 5, 6, true],
    ['gt', 5, 5, false],
    ['gte', 5, 5, true],
    ['gte', 5, 4, false],
    ['eq', 5, 5, true],
    ['eq', 5, 6, false],
    ['neq', 5, 6, true],
    ['neq', 5, 5, false],
  ])('evaluateAssertion(op=%s, expected=%d, actual=%d) === %s', (op, expected, actual, want) => {
    expect(evaluateAssertion(make(op, expected), actual)).toBe(want);
  });

  it('returns false for unknown operator on the assertion', () => {
    const bad: ScenarioAssertion = {
      metric: 'error_rate',
      operator: 'unknown' as ScenarioAssertion['operator'],
      value: 0,
      message: 'x',
    };
    expect(evaluateAssertion(bad, 0)).toBe(false);
  });
});

describe('getOperatorDescription', () => {
  it.each([
    ['lt', 'less than'],
    ['lte', 'at most'],
    ['gt', 'greater than'],
    ['gte', 'at least'],
    ['eq', 'equal to'],
    ['neq', 'not equal to'],
  ])('getOperatorDescription(%s) === %s', (op, want) => {
    expect(getOperatorDescription(op as Parameters<typeof getOperatorDescription>[0]))
      .toBe(want);
  });

  it('returns the operator string for unknown operators', () => {
    expect(getOperatorDescription('unknown' as Parameters<typeof getOperatorDescription>[0]))
      .toBe('unknown');
  });
});
