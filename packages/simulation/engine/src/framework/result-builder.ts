// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
/**
 * @fileoverview Fluent builder for scenario execution results
 *
 * Metrics must be set before build(). Result is immutable after build().
 * Assertions are evaluated in order.
 */

import { ValidationError } from '@opensip-tools/core'

import { evaluateAssertion } from './assertions.js'

import type { SimulationMetrics } from '../types/base-types.js'
import type {
  ScenarioAssertion,
  FailedAssertion,
  // eslint-disable-next-line sonarjs/deprecation -- this builder IS the legacy load-result implementation; the deprecated type is its return shape by design
  LegacyLoadResultPayload,
} from '../types/framework-types.js'
import type { Signal } from '@opensip-tools/core'



// =============================================================================
// METRIC MAPPING
// =============================================================================

const METRIC_FIELD_MAP: Record<string, keyof SimulationMetrics | null> = {
  error_rate: null,
  success_rate: null,
  avg_latency_ms: 'avgLatencyMs',
  p50_latency_ms: 'p50LatencyMs',
  p95_latency_ms: 'p95LatencyMs',
  p99_latency_ms: 'p99LatencyMs',
  requests_per_second: null,
  total_requests: 'totalRequests',
  successful_requests: 'successfulRequests',
  failed_requests: 'failedRequests',
  errors_generated: 'errorsGenerated',
  findings_generated: 'findingsGenerated',
}

// =============================================================================
// RESULT BUILDER
// =============================================================================

/**
 * Builder for scenario execution results.
 * Ensures consistent result structure across all scenarios.
 *
 * @example
 * ```typescript
 * const result = ScenarioResultBuilder.create('my-scenario')
 *   .withMetrics(collectedMetrics)
 *   .evaluateAssertions(scenario.assertions)
 *   .addSignals(generatedSignals)
 *   .build();
 * ```
 */
export class ScenarioResultBuilder {
  private readonly scenarioId: string
  private _metrics: SimulationMetrics | null = null
  private _duration: number | null = null
  private readonly _passedAssertions: ScenarioAssertion[] = []
  private readonly _failedAssertions: FailedAssertion[] = []
  private readonly _signals: Signal[] = []

  private constructor(scenarioId: string) {
    this.scenarioId = scenarioId
  }

  /** Get the scenario ID for this builder. */
  getScenarioId(): string {
    return this.scenarioId
  }

  /** Create a new result builder. */
  static create(scenarioId: string): ScenarioResultBuilder {
    return new ScenarioResultBuilder(scenarioId)
  }

  // ===========================================================================
  // METRICS
  // ===========================================================================

  /** Set the simulation metrics. */
  withMetrics(metrics: SimulationMetrics): this {
    this._metrics = metrics
    return this
  }

  /** Set the scenario duration in seconds (used for derived metrics like RPS). */
  withDuration(seconds: number): this {
    this._duration = seconds
    return this
  }

  // ===========================================================================
  // ASSERTIONS
  // ===========================================================================

  /** Record a passed assertion. */
  assertionPassed(assertion: ScenarioAssertion): this {
    this._passedAssertions.push(assertion)
    return this
  }

  /** Record a failed assertion. */
  assertionFailed(assertion: ScenarioAssertion, actual: number): this {
    this._failedAssertions.push({ ...assertion, actual })
    return this
  }

  /** Evaluate all assertions against the current metrics. */
  evaluateAssertions(assertions: readonly ScenarioAssertion[]): this {
    if (!this._metrics) {
      // @fitness-ignore-next-line result-pattern-consistency -- builder precondition, throw is appropriate
      throw new ValidationError(
        'Metrics must be set before evaluating assertions. Call withMetrics() first.',
        { code: 'VALIDATION.RESULT_BUILDER.METRICS_REQUIRED' },
      )
    }

    for (const assertion of assertions) {
      const actual = this.getMetricValue(assertion.metric)
      if (evaluateAssertion(assertion, actual)) {
        this.assertionPassed(assertion)
      } else {
        this.assertionFailed(assertion, actual)
      }
    }

    return this
  }

  // ===========================================================================
  // SIGNALS
  // ===========================================================================

  /** Add a single signal. */
  addSignal(signal: Signal): this {
    this._signals.push(signal)
    return this
  }

  /** Add multiple signals. */
  addSignals(signals: readonly Signal[]): this {
    this._signals.push(...signals)
    return this
  }

  // ===========================================================================
  // BUILD
  // ===========================================================================

  /** Build the final load-shaped payload. Throws if metrics are not set. */
  // @fitness-ignore-next-line result-pattern-consistency -- return type is LegacyLoadResultPayload (not canonical Result); throw is a builder precondition
  // eslint-disable-next-line sonarjs/deprecation -- legacy builder return type, kept for back-compat
  build(): LegacyLoadResultPayload {
    if (!this._metrics) {
      // @fitness-ignore-next-line result-pattern-consistency -- builder precondition, throw is appropriate
      throw new ValidationError('Metrics are required. Call withMetrics() before build().', {
        code: 'VALIDATION.RESULT_BUILDER.METRICS_REQUIRED',
      })
    }

    return Object.freeze({
      passed: this._failedAssertions.length === 0,
      metrics: this._metrics,
      assertions: Object.freeze({
        passed: Object.freeze([...this._passedAssertions]),
        failed: Object.freeze([...this._failedAssertions]),
      }),
      signals: Object.freeze([...this._signals]),
    })
  }

  // ===========================================================================
  // PRIVATE
  // ===========================================================================

  private getMetricValue(metric: string): number {
    if (!this._metrics) {
      return 0
    }

    const fieldName = METRIC_FIELD_MAP[metric]
    if (fieldName) {
      return this._metrics[fieldName]
    }

    switch (metric) {
      case 'error_rate': {
        return this._metrics.totalRequests > 0
          ? this._metrics.failedRequests / this._metrics.totalRequests
          : 0
      }

      case 'success_rate': {
        return this._metrics.totalRequests > 0
          ? this._metrics.successfulRequests / this._metrics.totalRequests
          : 0
      }

      case 'requests_per_second': {
        if (!this._duration || this._duration <= 0) {
          return 0
        }
        return this._metrics.totalRequests / this._duration
      }

      default: {
        return 0
      }
    }
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Create an empty/initial metrics object.
 */
export function createEmptyMetrics(): SimulationMetrics {
  return {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    avgLatencyMs: 0,
    p50LatencyMs: 0,
    p95LatencyMs: 0,
    p99LatencyMs: 0,
    errorsGenerated: 0,
    findingsGenerated: 0,
  }
}

/**
 * Merge multiple metrics objects.
 * Useful for aggregating metrics from parallel execution.
 */
export function mergeMetrics(metricsList: readonly SimulationMetrics[]): SimulationMetrics {
  if (metricsList.length === 0) {
    return createEmptyMetrics()
  }

  if (metricsList.length === 1) {
    const first = metricsList[0]
    return first ?? createEmptyMetrics()
  }

  const totalRequests = metricsList.reduce((sum, m) => sum + m.totalRequests, 0)
  const totalSuccessful = metricsList.reduce((sum, m) => sum + m.successfulRequests, 0)
  const totalFailed = metricsList.reduce((sum, m) => sum + m.failedRequests, 0)

  const weightedAvgLatency =
    totalRequests > 0
      ? metricsList.reduce((sum, m) => sum + m.avgLatencyMs * m.totalRequests, 0) / totalRequests
      : 0

  const p50 = Math.max(...metricsList.map((m) => m.p50LatencyMs))
  const p95 = Math.max(...metricsList.map((m) => m.p95LatencyMs))
  const p99 = Math.max(...metricsList.map((m) => m.p99LatencyMs))

  return {
    totalRequests,
    successfulRequests: totalSuccessful,
    failedRequests: totalFailed,
    avgLatencyMs: weightedAvgLatency,
    p50LatencyMs: p50,
    p95LatencyMs: p95,
    p99LatencyMs: p99,
    errorsGenerated: metricsList.reduce((sum, m) => sum + m.errorsGenerated, 0),
    findingsGenerated: metricsList.reduce((sum, m) => sum + m.findingsGenerated, 0),
  }
}
