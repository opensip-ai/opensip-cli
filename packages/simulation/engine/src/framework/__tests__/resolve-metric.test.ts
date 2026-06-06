/**
 * @fileoverview Tests pinning the canonical metric resolver.
 *
 * Includes the symmetry regression: both `validateAssertions` (used by the
 * execution-engine path) and `ScenarioResultBuilder.evaluateAssertions`
 * (used by the kind executors) MUST produce the same actual value via
 * `resolveMetric`. Before the unification, the two paths returned
 * different values for `success_rate` on `totalRequests === 0` and
 * disagreed on which keys were resolvable.
 */

import { describe, expect, it } from 'vitest';

import { validateAssertions } from '../execution/execution-engine.js';
import { resolveMetric } from '../resolve-metric.js';
import { ScenarioResultBuilder, createEmptyMetrics } from '../result-builder.js';

import type { SimulationMetrics, ScenarioAssertion } from '../../types/base-types.js';
import type { ScenarioMetricKey } from '../resolve-metric.js';

const baseMetrics = (overrides: Partial<SimulationMetrics> = {}): SimulationMetrics => ({
  ...createEmptyMetrics(),
  totalRequests: 100,
  successfulRequests: 95,
  failedRequests: 5,
  avgLatencyMs: 40,
  p50LatencyMs: 30,
  p95LatencyMs: 70,
  p99LatencyMs: 100,
  errorsGenerated: 5,
  ...overrides,
});

/**
 * Run an assertion through both metric-resolution paths and compare. The
 * `eq` operator with the resolver's value as `expected` lets us read the
 * canonical actual back out of the validateAssertions path's `failed[].actual`
 * (we treat any failure with the same `actual` as success for the symmetry
 * check).
 */
function actualFromValidateAssertions(
  metrics: SimulationMetrics,
  metric: ScenarioMetricKey,
): number {
  const a: ScenarioAssertion = {
    metric,
    operator: 'eq',
    // Force a failure so we can read `failed[0].actual`.
    value: Number.NaN,
    message: 'symmetry probe',
  };
  const out = validateAssertions(metrics, [a]);
  // NaN !== NaN ⇒ failed list always populated for this probe.
  return out.failed[0]?.actual ?? Number.NaN;
}

function actualFromResultBuilder(
  metrics: SimulationMetrics,
  metric: ScenarioMetricKey,
  durationSeconds?: number,
): number {
  const a: ScenarioAssertion = {
    metric,
    operator: 'eq',
    value: Number.NaN,
    message: 'symmetry probe',
  };
  const builder = ScenarioResultBuilder.create('probe').withMetrics(metrics);
  const built = (durationSeconds === undefined ? builder : builder.withDuration(durationSeconds))
    .evaluateAssertions([a])
    .build();
  return built.assertions.failed[0]?.actual ?? Number.NaN;
}

describe('resolveMetric symmetry', () => {
  it('chaos recovery_rate produces the same value via both paths', () => {
    const m = baseMetrics({ errorsGenerated: 10, failedRequests: 2 });
    const expected = resolveMetric('recovery_rate', m);
    expect(actualFromValidateAssertions(m, 'recovery_rate')).toBeCloseTo(expected);
    expect(actualFromResultBuilder(m, 'recovery_rate')).toBeCloseTo(expected);
    // And the value is the documented one (1 - 2/10 = 0.8).
    expect(expected).toBeCloseTo(0.8);
  });

  it('recovery_rate is 1 when no errors generated, both paths agree', () => {
    const m = baseMetrics({ errorsGenerated: 0, failedRequests: 0 });
    expect(actualFromValidateAssertions(m, 'recovery_rate')).toBe(1);
    expect(actualFromResultBuilder(m, 'recovery_rate')).toBe(1);
  });

  it('success_rate is 0 with zero requests, both paths agree (tightening)', () => {
    const m = baseMetrics({ totalRequests: 0, successfulRequests: 0 });
    expect(actualFromValidateAssertions(m, 'success_rate')).toBe(0);
    expect(actualFromResultBuilder(m, 'success_rate')).toBe(0);
  });

  it.each<[ScenarioMetricKey, Partial<SimulationMetrics>, number]>([
    ['error_rate', { totalRequests: 200, failedRequests: 50 }, 0.25],
    ['success_rate', { totalRequests: 200, successfulRequests: 180 }, 0.9],
    ['p50_latency_ms', { p50LatencyMs: 33 }, 33],
    ['p95_latency_ms', { p95LatencyMs: 88 }, 88],
    ['p99_latency_ms', { p99LatencyMs: 200 }, 200],
    ['avg_latency_ms', { avgLatencyMs: 45 }, 45],
    ['total_requests', { totalRequests: 7 }, 7],
    ['failed_requests', { failedRequests: 4 }, 4],
  ])('%s resolves to %d via both paths', (metric, overrides, expected) => {
    const m = baseMetrics(overrides);
    expect(actualFromValidateAssertions(m, metric)).toBeCloseTo(expected);
    expect(actualFromResultBuilder(m, metric)).toBeCloseTo(expected);
  });

  it('requests_per_second resolves via the result-builder path with duration', () => {
    const m = baseMetrics({ totalRequests: 100 });
    expect(actualFromResultBuilder(m, 'requests_per_second', 10)).toBeCloseTo(10);
    // Without duration in the validate-assertions path, the value is 0
    // (no duration plumbed through). Documented behaviour.
    expect(actualFromValidateAssertions(m, 'requests_per_second')).toBe(0);
  });

  it('reserved keys (cpu_percent, memory_mb, max_latency_ms) resolve to 0', () => {
    const m = baseMetrics();
    expect(resolveMetric('cpu_percent', m)).toBe(0);
    expect(resolveMetric('memory_mb', m)).toBe(0);
    expect(resolveMetric('max_latency_ms', m)).toBe(0);
  });

  it('resolves the raw count metric keys directly off SimulationMetrics', () => {
    const m = baseMetrics({
      successfulRequests: 95,
      failedRequests: 5,
      errorsGenerated: 7,
      totalRequests: 100,
    });
    expect(resolveMetric('successful_requests', m)).toBe(95);
    expect(resolveMetric('failed_requests', m)).toBe(5);
    expect(resolveMetric('errors_generated', m)).toBe(7);
    expect(resolveMetric('total_requests', m)).toBe(100);
  });

  it('falls through to 0 for a key outside the supported set (type-bypass guard)', () => {
    const m = baseMetrics();
    // A caller that deliberately bypasses the compile-time narrowing hits the
    // exhaustive default arm, which returns 0.
    expect(resolveMetric('not-a-real-metric' as ScenarioMetricKey, m)).toBe(0);
  });
});
