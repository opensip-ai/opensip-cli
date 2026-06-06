/**
 * @fileoverview `Workload` — the neutral arrival-rate model the load-window
 * driver consumes.
 *
 * Replaces the persona model (buyer/seller/admin `spawnRate`), which was
 * parent-SaaS domain vestige the driver only ever collapsed into a single RPS
 * number. A workload states the target request rate directly, plus an optional
 * in-flight concurrency cap and ramp-up.
 */

/** Author-facing workload for a load/chaos scenario. */
export interface Workload {
  /** Target requests per second the driver paces toward. */
  readonly rps: number
  /**
   * Maximum in-flight requests. When omitted, derived from `rps` via
   * {@link resolveConcurrency} so authors need only specify `rps`.
   */
  readonly concurrency?: number
  /** Linear ramp-up from 0 to `rps`, in seconds. Defaults to 0 (no ramp). */
  readonly rampUp?: number
}

/**
 * Resolve the in-flight concurrency cap for a workload.
 *
 * When `concurrency` is set, it wins. Otherwise derive a bound from `rps`:
 * roughly one in-flight slot per 5 rps (min 1). This keeps a default scenario
 * from issuing an unbounded burst while still letting real latency overlap.
 */
export function resolveConcurrency(workload: Workload): number {
  return workload.concurrency ?? Math.max(1, Math.ceil(workload.rps / 5))
}
