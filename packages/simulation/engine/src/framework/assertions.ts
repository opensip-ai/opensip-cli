/**
 * @fileoverview Pre-built assertions for simulation scenarios
 *
 * All assertion functions are pure (no side effects).
 * Default thresholds are production-safe.
 * Custom assertions allow escape hatch.
 */

import type { ScenarioAssertion, AssertionOperator } from '../types/framework-types.js'

// =============================================================================
// ASSERTION BUILDERS
// =============================================================================

/**
 * Pre-built assertions for common metrics.
 *
 * @example
 * ```typescript
 * export const myScenario = defineScenario({
 *   // ...
 *   assertions: [
 *     ASSERTIONS.lowErrorRate(),
 *     ASSERTIONS.lowLatency('p95', 500),
 *     ASSERTIONS.minThroughput(100),
 *   ],
 * });
 * ```
 */
export const ASSERTIONS = {
  // ===========================================================================
  // ERROR RATE
  // ===========================================================================

  /**
   * Assert that error rate is below threshold.
   * @param threshold - Maximum error rate (0-1). Default: 0.05 (5%)
   */
  lowErrorRate: (threshold = 0.05): ScenarioAssertion => ({
    metric: 'error_rate',
    operator: 'lt',
    value: threshold,
    message: `Error rate must be < ${(threshold * 100).toFixed(1)}%`,
  }),

  /**
   * Assert zero errors.
   */
  zeroErrors: (): ScenarioAssertion => ({
    metric: 'error_rate',
    operator: 'eq',
    value: 0,
    message: 'Error rate must be 0%',
  }),

  // ===========================================================================
  // LATENCY
  // ===========================================================================

  /**
   * Assert that latency percentile is below threshold.
   * @param percentile - Which percentile to check (p50, p95, p99)
   * @param thresholdMs - Maximum latency in milliseconds
   */
  lowLatency: (
    percentile: 'p50' | 'p95' | 'p99' = 'p95',
    thresholdMs = 500,
  ): ScenarioAssertion => ({
    metric: `${percentile}_latency_ms`,
    operator: 'lt',
    value: thresholdMs,
    message: `${percentile.toUpperCase()} latency must be < ${thresholdMs}ms`,
  }),

  /**
   * Assert that average latency is below threshold.
   * @param thresholdMs - Maximum average latency in milliseconds
   */
  avgLatency: (thresholdMs = 200): ScenarioAssertion => ({
    metric: 'avg_latency_ms',
    operator: 'lt',
    value: thresholdMs,
    message: `Average latency must be < ${thresholdMs}ms`,
  }),

  /**
   * Assert that max latency is below threshold.
   * @param thresholdMs - Maximum latency in milliseconds
   */
  maxLatency: (thresholdMs = 2000): ScenarioAssertion => ({
    metric: 'max_latency_ms',
    operator: 'lt',
    value: thresholdMs,
    message: `Max latency must be < ${thresholdMs}ms`,
  }),

  // ===========================================================================
  // THROUGHPUT
  // ===========================================================================

  /**
   * Assert minimum throughput.
   * @param rps - Minimum requests per second
   */
  minThroughput: (rps: number): ScenarioAssertion => ({
    metric: 'requests_per_second',
    operator: 'gte',
    value: rps,
    message: `Throughput must be >= ${rps} RPS`,
  }),

  /**
   * Assert maximum throughput (useful for rate limiting tests).
   * @param rps - Maximum requests per second
   */
  maxThroughput: (rps: number): ScenarioAssertion => ({
    metric: 'requests_per_second',
    operator: 'lte',
    value: rps,
    message: `Throughput must be <= ${rps} RPS`,
  }),

  // ===========================================================================
  // SUCCESS RATE
  // ===========================================================================

  /**
   * Assert high success rate.
   * @param threshold - Minimum success rate (0-1). Default: 0.95 (95%)
   */
  highSuccessRate: (threshold = 0.95): ScenarioAssertion => ({
    metric: 'success_rate',
    operator: 'gte',
    value: threshold,
    message: `Success rate must be >= ${(threshold * 100).toFixed(1)}%`,
  }),

  /**
   * Assert 100% success rate.
   */
  perfectSuccessRate: (): ScenarioAssertion => ({
    metric: 'success_rate',
    operator: 'eq',
    value: 1,
    message: 'Success rate must be 100%',
  }),

  // ===========================================================================
  // RESOURCE USAGE
  // ===========================================================================

  /**
   * Assert memory usage is below threshold.
   * @param thresholdMb - Maximum memory in megabytes
   */
  memoryUsage: (thresholdMb: number): ScenarioAssertion => ({
    metric: 'memory_mb',
    operator: 'lt',
    value: thresholdMb,
    message: `Memory usage must be < ${thresholdMb}MB`,
  }),

  /**
   * Assert CPU usage is below threshold.
   * @param threshold - Maximum CPU percentage (0-100)
   */
  cpuUsage: (threshold: number): ScenarioAssertion => ({
    metric: 'cpu_percent',
    operator: 'lt',
    value: threshold,
    message: `CPU usage must be < ${threshold}%`,
  }),

  // ===========================================================================
  // CUSTOM
  // ===========================================================================

  /**
   * Create a custom assertion.
   *
   * @example
   * ```typescript
   * ASSERTIONS.custom('listing_creation_time_ms', 'lt', 1000, 'Listing creation must be < 1s')
   * ```
   */
  custom: (
    metric: string,
    operator: AssertionOperator,
    value: number,
    message?: string,
  ): ScenarioAssertion => ({
    metric,
    operator,
    value,
    message: message ?? `${metric} ${operator} ${value}`,
  }),
} as const

/**
 * Type for the ASSERTIONS object.
 */
export type AssertionFactory = typeof ASSERTIONS

// =============================================================================
// ASSERTION EVALUATION
// =============================================================================

/**
 * Evaluate an operator comparison (low-level).
 */
export function evaluateOperator(
  actual: number,
  operator: AssertionOperator,
  expected: number,
): boolean {
  switch (operator) {
    case 'lt':
      return actual < expected
    case 'lte':
      return actual <= expected
    case 'gt':
      return actual > expected
    case 'gte':
      return actual >= expected
    case 'eq':
      return actual === expected
    case 'neq':
      return actual !== expected
    default:
      return false
  }
}

/**
 * Evaluate an assertion against an actual value.
 */
export function evaluateAssertion(assertion: ScenarioAssertion, actual: number): boolean {
  switch (assertion.operator) {
    case 'lt':
      return actual < assertion.value
    case 'lte':
      return actual <= assertion.value
    case 'gt':
      return actual > assertion.value
    case 'gte':
      return actual >= assertion.value
    case 'eq':
      return actual === assertion.value
    case 'neq':
      return actual !== assertion.value
    default:
      return false
  }
}

/**
 * Get a human-readable description of an operator.
 */
export function getOperatorDescription(operator: AssertionOperator): string {
  switch (operator) {
    case 'lt':
      return 'less than'
    case 'lte':
      return 'at most'
    case 'gt':
      return 'greater than'
    case 'gte':
      return 'at least'
    case 'eq':
      return 'equal to'
    case 'neq':
      return 'not equal to'
    default:
      return operator
  }
}
