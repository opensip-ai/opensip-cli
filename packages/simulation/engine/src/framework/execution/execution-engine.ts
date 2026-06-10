/**
 * @fileoverview Small public utilities for scenario execution.
 *
 * Historically this file housed the legacy `runSimulationLoop` /
 * `createScenario` / `createStandardExecutor` orchestration model. That
 * model was retired once both kinds (load, chaos) unified on the new
 * `ScenarioExecutionContext` / `runLoadWindow` model in Wave 4 of the
 * Layer 3 remediation plan; the legacy `defineScenario` alias was deleted
 * in the same release.
 *
 * What remains here is a small set of stable helpers consumed across
 * the simulation runtime:
 *
 *   - `validateAssertions` — evaluate assertions against metrics.
 *   - `updateLatencyMetrics` — quick in-loop latency sample update
 *     (rough percentiles; prefer `LatencyTracker` when accuracy matters).
 *   - `sleepWithAbort` — abortable sleep used by both windowed runs and
 *     scenario test fixtures.
 *   - `scenarioAborted` — standalone abort-check helper.
 *
 * `ScenarioAbortedError` is re-exported here so kind executors can keep
 * importing it from a single, stable location.
 */

import { evaluateOperator } from '../assertions.js';
import { resolveMetric } from '../resolve-metric.js';

import { ScenarioAbortedError } from './scenario-aborted-error.js';

import type { SimulationMetrics, ScenarioAssertion } from '../../types/base-types.js';

// =============================================================================
// ASSERTION VALIDATION
// =============================================================================

/**
 * Validate assertions against metrics.
 */
export function validateAssertions(
  metrics: SimulationMetrics,
  assertions: ScenarioAssertion[],
): { passed: boolean; failed: { assertion: ScenarioAssertion; actual: number }[] } {
  if (!Array.isArray(assertions)) {
    return { passed: false, failed: [] };
  }

  const failed: { assertion: ScenarioAssertion; actual: number }[] = [];

  for (const assertion of assertions) {
    const actual = resolveMetric(assertion.metric, metrics);
    const passed = evaluateOperator(actual, assertion.operator, assertion.value);

    if (!passed) {
      failed.push({ assertion, actual });
    }
  }

  return { passed: failed.length === 0, failed };
}

// =============================================================================
// METRICS UTILITIES
// =============================================================================

/**
 * Update latency metrics with a new sample.
 *
 * WARNING: Percentile values (p50, p95, p99) are rough estimates derived from
 * the running average. For accurate percentiles, use LatencyTracker instead.
 * This function is intended for quick in-loop metric updates where
 * maintaining a full sample set is impractical.
 */
export function updateLatencyMetrics(metrics: SimulationMetrics, latency: number): void {
  const n = metrics.totalRequests;
  if (n === 0) {
    metrics.avgLatencyMs = latency;
    metrics.p50LatencyMs = latency;
    metrics.p95LatencyMs = latency;
    metrics.p99LatencyMs = latency;
  } else {
    metrics.avgLatencyMs = (metrics.avgLatencyMs * (n - 1) + latency) / n;
    // Rough estimates — use LatencyTracker.getLatencySnapshot() for real percentiles
    metrics.p50LatencyMs = metrics.avgLatencyMs * 0.9;
    metrics.p95LatencyMs = metrics.avgLatencyMs * 1.5;
    metrics.p99LatencyMs = metrics.avgLatencyMs * 2;
  }
}

// =============================================================================
// SLEEP UTILITY
// =============================================================================

/**
 * Sleep for a specified duration with abort support.
 * @throws {ScenarioAbortedError} When the abort signal is triggered
 */
export function sleepWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ScenarioAbortedError());
      return;
    }

    const abortHandler = () => {
      clearTimeout(timeout);
      reject(new ScenarioAbortedError());
    };

    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abortHandler);
      resolve();
    }, ms);

    signal.addEventListener('abort', abortHandler, { once: true });
  });
}

// =============================================================================
// ABORT HELPER
// =============================================================================

/**
 * Standalone checkAborted helper for use outside an execution loop.
 * @throws {ScenarioAbortedError} When the abort signal has been triggered
 */
export function scenarioAborted(signal: AbortSignal | undefined, scenarioId?: string): void {
  if (signal?.aborted) {
    throw new ScenarioAbortedError(scenarioId);
  }
}

export { ScenarioAbortedError } from './scenario-aborted-error.js';
