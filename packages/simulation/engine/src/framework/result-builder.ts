// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
/**
 * @fileoverview Fluent builder for scenario execution results
 *
 * Metrics must be set before build(). Result is immutable after build().
 * Assertions are evaluated in order.
 */

import { createSignal, isErrorSignal, ValidationError } from '@opensip-cli/core';

import { evaluateAssertion } from './assertions.js';
import { resolveMetric } from './resolve-metric.js';

import type { SimulationMetrics } from '../types/base-types.js';
import type {
  ScenarioAssertion,
  FailedAssertion,
  LoadResultPayload,
} from '../types/framework-types.js';
import type { Signal } from '@opensip-cli/core';

/**
 * Build the single error-severity signal that represents a failed scenario
 * (ADR-0011 / ADR-0035). A failed scenario must surface in the signal currency
 * so the host verdict — and every sink (`--json`, SARIF, cloud) — sees it; the
 * pre-ADR-0035 sim emitted no signal on failure, leaving `errors === 0` for a
 * run that should fail. One `high`-severity signal per failed scenario,
 * attributed to its `scenarioId`, summarizing the failed assertions. Shared by
 * the load path (via `build()`) and the chaos executor.
 */
export function buildFailedScenarioSignal(
  scenarioId: string,
  failedAssertions: readonly FailedAssertion[],
): Signal {
  const detail = failedAssertions
    .map((a) => `${a.metric} ${a.operator} ${String(a.value)} (actual ${String(a.actual)})`)
    .join('; ');
  return createSignal({
    source: scenarioId,
    severity: 'high',
    category: 'resilience',
    ruleId: `sim:${scenarioId}`,
    message: `Scenario '${scenarioId}' failed ${String(failedAssertions.length)} assertion(s): ${detail}`,
  });
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
  private readonly scenarioId: string;
  private _metrics: SimulationMetrics | null = null;
  private _duration: number | null = null;
  private readonly _passedAssertions: ScenarioAssertion[] = [];
  private readonly _failedAssertions: FailedAssertion[] = [];
  private readonly _signals: Signal[] = [];

  private constructor(scenarioId: string) {
    this.scenarioId = scenarioId;
  }

  /** Get the scenario ID for this builder. */
  getScenarioId(): string {
    return this.scenarioId;
  }

  /** Create a new result builder. */
  static create(scenarioId: string): ScenarioResultBuilder {
    return new ScenarioResultBuilder(scenarioId);
  }

  // ===========================================================================
  // METRICS
  // ===========================================================================

  /** Set the simulation metrics. */
  withMetrics(metrics: SimulationMetrics): this {
    this._metrics = metrics;
    return this;
  }

  /** Set the scenario duration in seconds (used for derived metrics like RPS). */
  withDuration(seconds: number): this {
    this._duration = seconds;
    return this;
  }

  // ===========================================================================
  // ASSERTIONS
  // ===========================================================================

  /** Record a passed assertion. */
  assertionPassed(assertion: ScenarioAssertion): this {
    this._passedAssertions.push(assertion);
    return this;
  }

  /** Record a failed assertion. */
  assertionFailed(assertion: ScenarioAssertion, actual: number): this {
    this._failedAssertions.push({ ...assertion, actual });
    return this;
  }

  /** Evaluate all assertions against the current metrics. */
  evaluateAssertions(assertions: readonly ScenarioAssertion[]): this {
    if (!this._metrics) {
      throw new ValidationError(
        'Metrics must be set before evaluating assertions. Call withMetrics() first.',
        { code: 'VALIDATION.RESULT_BUILDER.METRICS_REQUIRED' },
      );
    }

    for (const assertion of assertions) {
      const actual = this.resolveAssertionMetric(assertion.metric);
      if (evaluateAssertion(assertion, actual)) {
        this.assertionPassed(assertion);
      } else {
        this.assertionFailed(assertion, actual);
      }
    }

    return this;
  }

  // ===========================================================================
  // SIGNALS
  // ===========================================================================

  /** Add a single signal. */
  addSignal(signal: Signal): this {
    this._signals.push(signal);
    return this;
  }

  /** Add multiple signals. */
  addSignals(signals: readonly Signal[]): this {
    this._signals.push(...signals);
    return this;
  }

  // ===========================================================================
  // BUILD
  // ===========================================================================

  /** Build the final load-shaped payload. Throws if metrics are not set. */
  build(): LoadResultPayload {
    if (!this._metrics) {
      throw new ValidationError('Metrics are required. Call withMetrics() before build().', {
        code: 'VALIDATION.RESULT_BUILDER.METRICS_REQUIRED',
      });
    }

    // ADR-0035: a failed scenario must emit an error-severity signal so the host
    // verdict sees the failure (the signal currency, not just `passed`). Append
    // one unless the scenario already authored an error signal of its own.
    const signals = [...this._signals];
    if (this._failedAssertions.length > 0 && !signals.some(isErrorSignal)) {
      signals.push(buildFailedScenarioSignal(this.scenarioId, this._failedAssertions));
    }

    return Object.freeze({
      passed: this._failedAssertions.length === 0,
      metrics: this._metrics,
      assertions: Object.freeze({
        passed: Object.freeze([...this._passedAssertions]),
        failed: Object.freeze([...this._failedAssertions]),
      }),
      signals: Object.freeze(signals),
    });
  }

  // ===========================================================================
  // PRIVATE
  // ===========================================================================

  private resolveAssertionMetric(metric: ScenarioAssertion['metric']): number {
    /* v8 ignore next 3 -- unreachable defensive guard: the only caller
       (evaluateAssertions) already throws when `_metrics` is unset, so this
       branch can never fire through the public API. */
    if (!this._metrics) {
      return 0;
    }
    return resolveMetric(metric, this._metrics, this._duration ?? undefined);
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
  };
}

/**
 * Merge multiple metrics objects.
 * Useful for aggregating metrics from parallel execution.
 */
export function mergeMetrics(metricsList: readonly SimulationMetrics[]): SimulationMetrics {
  if (metricsList.length === 0) {
    return createEmptyMetrics();
  }

  if (metricsList.length === 1) {
    const first = metricsList[0];
    return first ?? createEmptyMetrics();
  }

  const totalRequests = metricsList.reduce((sum, m) => sum + m.totalRequests, 0);
  const totalSuccessful = metricsList.reduce((sum, m) => sum + m.successfulRequests, 0);
  const totalFailed = metricsList.reduce((sum, m) => sum + m.failedRequests, 0);

  const weightedAvgLatency =
    totalRequests > 0
      ? metricsList.reduce((sum, m) => sum + m.avgLatencyMs * m.totalRequests, 0) / totalRequests
      : 0;

  const p50 = Math.max(...metricsList.map((m) => m.p50LatencyMs));
  const p95 = Math.max(...metricsList.map((m) => m.p95LatencyMs));
  const p99 = Math.max(...metricsList.map((m) => m.p99LatencyMs));

  return {
    totalRequests,
    successfulRequests: totalSuccessful,
    failedRequests: totalFailed,
    avgLatencyMs: weightedAvgLatency,
    p50LatencyMs: p50,
    p95LatencyMs: p95,
    p99LatencyMs: p99,
    errorsGenerated: metricsList.reduce((sum, m) => sum + m.errorsGenerated, 0),
  };
}
