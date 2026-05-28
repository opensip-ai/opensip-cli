/**
 * @fileoverview Single source of truth for resolving simulation-metric keys
 * to numeric values.
 *
 * Both `validateAssertions` (in `execution/execution-engine.ts`) and
 * `ScenarioResultBuilder.evaluateAssertions` (in `result-builder.ts`)
 * delegate here. Before this module existed, each kept its own resolver
 * and the two diverged — most visibly on `success_rate` when
 * `totalRequests === 0`.
 *
 * ## Supported keys
 *
 * Computed (derived from raw counters):
 *
 *   - `error_rate`         — `failedRequests / totalRequests`,
 *                            `0` when `totalRequests === 0`.
 *   - `success_rate`       — `successfulRequests / totalRequests`,
 *                            **`0` when `totalRequests === 0`**. See note below.
 *   - `recovery_rate`      — `1 - failedRequests / errorsGenerated`,
 *                            `1` when `errorsGenerated === 0` (no errors to
 *                            recover from ⇒ trivially fully recovered).
 *   - `requests_per_second` — `totalRequests / durationSeconds`,
 *                             `0` when `durationSeconds` is missing or `<= 0`.
 *
 * Direct field accessors (passthrough to `SimulationMetrics`):
 *
 *   - `avg_latency_ms`, `avg_latency`           → `avgLatencyMs`
 *   - `p50_latency_ms`, `p50_latency`           → `p50LatencyMs`
 *   - `p95_latency_ms`, `p95_latency`           → `p95LatencyMs`
 *   - `p99_latency_ms`, `p99_latency`           → `p99LatencyMs`
 *   - `total_requests`                          → `totalRequests`
 *   - `successful_requests`                     → `successfulRequests`
 *   - `failed_requests`                         → `failedRequests`
 *   - `errors_generated`                        → `errorsGenerated`
 *   - `findings_generated`                      → `findingsGenerated`
 *
 * Reserved keys (recognised at type-level, not yet populated by any executor;
 * resolver returns `0`):
 *
 *   - `max_latency_ms`     — produced by `ASSERTIONS.maxLatency()`.
 *   - `memory_mb`          — produced by `ASSERTIONS.memoryUsage()`.
 *   - `cpu_percent`        — produced by `ASSERTIONS.cpuUsage()`.
 *
 * These exist so the standard ASSERTIONS factories continue to type-check.
 * Until an executor records the underlying field on `SimulationMetrics`, the
 * resolver returns `0` (assertions like `cpuUsage(80)` with operator `lt`
 * therefore pass trivially). Promote a reserved key to a real one by adding
 * the underlying field to `SimulationMetrics` and a case here.
 *
 * ## Note: `success_rate` with no requests
 *
 * When `totalRequests === 0`, `successfulRequests / totalRequests` is `0/0`.
 * The two historical resolvers disagreed:
 *
 *   - The execution-engine path returned `1` (no failures ⇒ pass).
 *   - The result-builder path returned `0` (no successes ⇒ fail).
 *
 * We pick **`0`**, matching the result-builder's existing pinned behaviour
 * (see `result-builder.test.ts` "success_rate is 0 when no requests"). The
 * rationale: a scenario that produced zero requests is misconfigured or
 * aborted-early, and a `highSuccessRate` assertion should _fail_ in that
 * case, not silently pass. The execution-engine path's old `1` result was
 * the looser, more-permissive choice and is the one being tightened.
 */

import type { ScenarioMetricKey } from './scenario-metric-key.js'
import type { SimulationMetrics } from '../types/base-types.js'

// `ScenarioMetricKey` moved to `./scenario-metric-key.ts` (a leaf
// module) to break the `resolve-metric.ts ↔ base-types.ts` file-level
// cycle. Re-exported here so existing callers (the engine barrel,
// downstream tools that build `ScenarioAssertion` values) keep their
// import paths.
export type { ScenarioMetricKey } from './scenario-metric-key.js'

/**
 * Resolve a metric key to its numeric value.
 *
 * @param metric - The metric key to resolve. See module-level docs for the
 *   full supported set and edge-case semantics.
 * @param metrics - The collected simulation metrics.
 * @param durationSeconds - Required only for `requests_per_second`. When
 *   missing or non-positive for that key, the function returns `0`.
 * @returns The numeric value. Unknown keys (post-narrowing — should be
 *   prevented at compile time) fall through to `0`.
 */
export function resolveMetric(
  metric: ScenarioMetricKey,
  metrics: SimulationMetrics,
  durationSeconds?: number,
): number {
  switch (metric) {
    case 'error_rate': {
      return metrics.totalRequests > 0
        ? metrics.failedRequests / metrics.totalRequests
        : 0
    }
    case 'success_rate': {
      // See module-level docs: `0` when totalRequests === 0 (tightening choice).
      return metrics.totalRequests > 0
        ? metrics.successfulRequests / metrics.totalRequests
        : 0
    }
    case 'recovery_rate': {
      // No errors to recover from ⇒ trivially fully recovered (1).
      return metrics.errorsGenerated > 0
        ? 1 - metrics.failedRequests / metrics.errorsGenerated
        : 1
    }
    case 'requests_per_second': {
      if (durationSeconds === undefined || durationSeconds <= 0) {
        return 0
      }
      return metrics.totalRequests / durationSeconds
    }
    case 'avg_latency':
    case 'avg_latency_ms': {
      return metrics.avgLatencyMs
    }
    case 'p50_latency':
    case 'p50_latency_ms': {
      return metrics.p50LatencyMs
    }
    case 'p95_latency':
    case 'p95_latency_ms': {
      return metrics.p95LatencyMs
    }
    case 'p99_latency':
    case 'p99_latency_ms': {
      return metrics.p99LatencyMs
    }
    case 'total_requests': {
      return metrics.totalRequests
    }
    case 'successful_requests': {
      return metrics.successfulRequests
    }
    case 'failed_requests': {
      return metrics.failedRequests
    }
    case 'errors_generated': {
      return metrics.errorsGenerated
    }
    case 'findings_generated': {
      return metrics.findingsGenerated
    }
    case 'max_latency_ms':
    case 'memory_mb':
    case 'cpu_percent': {
      // Reserved: no underlying field on SimulationMetrics yet.
      return 0
    }
    default: {
      // Exhaustive — `ScenarioMetricKey` should narrow to never here. This
      // branch only fires if a caller deliberately bypasses the type check.
      return 0
    }
  }
}
