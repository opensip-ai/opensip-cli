/**
 * @fileoverview `ScenarioMetricKey` — the union of metric ids recognised
 * by `resolveMetric`.
 *
 * Extracted from `resolve-metric.ts` into its own leaf module so
 * `../types/base-types.ts` can reference the union (for
 * `ScenarioAssertion.metric`) without forming a file-level cycle:
 *
 *   `resolve-metric.ts` →(type) `base-types.ts`  (uses `SimulationMetrics`)
 *   `base-types.ts`     →(type) `resolve-metric.ts`  (uses `ScenarioMetricKey`)
 *
 * With the union hosted here — a leaf that imports nothing from the
 * type or runtime layers — both consumers import without closing the
 * cycle. `resolve-metric.ts` re-exports the union for back-compat.
 */

/**
 * Union of every metric key recognised by `resolveMetric`.
 *
 * `ScenarioAssertion.metric` is typed as this union so a typo like
 * `'p99-latnecy'` is a TypeScript error at the assertion-construction
 * call site.
 */
export type ScenarioMetricKey =
  // Computed
  | 'error_rate'
  | 'success_rate'
  | 'recovery_rate'
  | 'requests_per_second'
  // Latency direct (with `_ms` and bare aliases)
  | 'avg_latency'
  | 'avg_latency_ms'
  | 'p50_latency'
  | 'p50_latency_ms'
  | 'p95_latency'
  | 'p95_latency_ms'
  | 'p99_latency'
  | 'p99_latency_ms'
  // Counter direct
  | 'total_requests'
  | 'successful_requests'
  | 'failed_requests'
  | 'errors_generated'
  // Reserved (returns 0 until an executor populates the underlying field)
  | 'max_latency_ms'
  | 'memory_mb'
  | 'cpu_percent';
