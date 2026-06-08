/**
 * WorkflowExecutionOptions — the unified execution-config shape every domain's
 * recipe runs on (north-star §5.8, release 2.13.0).
 *
 * Before 2.13.0 each domain declared its own shape — `FitnessExecutionOptions`
 * (richest: mode/stopOnFirstFailure/timeout/maxParallel/retry×2) and
 * `SimulationExecutionOptions` (mode/timeout/maxParallel/stopOnFirstFailure, with
 * `timeout` silently unenforced). This is the common base they map onto so
 * `timeout`/`maxParallel`/`stopOnFirstFailure` mean the SAME thing in every domain
 * — the "same words, same semantics" guarantee parity promises (§4.3). A domain
 * may carry extra fields (fitness's per-unit config) as an ADR-documented
 * difference (§6.7); the shared base is what the execution substrate consumes.
 */

/** Retry policy for a unit run (off by default). */
export interface WorkflowRetryOptions {
  readonly enabled: boolean;
  readonly maxRetries: number;
}

/** The execution config shared by fit + sim recipes; consumed by the substrate. */
export interface WorkflowExecutionOptions {
  /** Schedule units concurrently (bounded by `maxParallel`) or one at a time. */
  readonly mode: 'parallel' | 'sequential';
  /** Per-unit timeout in ms. A unit that exceeds it is aborted (sim's fix). */
  readonly timeout?: number;
  /** Bound on concurrent units in `parallel` mode. */
  readonly maxParallel?: number;
  /** Stop scheduling further units once one fails. */
  readonly stopOnFirstFailure?: boolean;
  /** Optional retry-on-failure (fitness uses it; sim does not). */
  readonly retry?: WorkflowRetryOptions;
}
