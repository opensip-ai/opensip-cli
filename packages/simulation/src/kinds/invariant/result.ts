/**
 * @fileoverview Invariant-kind result outcome.
 *
 * The invariant kind's lifecycle is `setup → act → assert`. The outcome
 * captures whether each phase ran to completion, plus the assertion-level
 * verdicts the `assert` phase produced. The phase verdict is structured as
 * a list rather than booleans so authors can record multiple invariant
 * checks within a single scenario without inventing per-scenario shapes.
 */

/** Status of a single phase. */
export type InvariantPhaseStatus = 'pending' | 'running' | 'passed' | 'failed'

/** Result of a single phase. */
export interface InvariantPhaseResult {
  readonly phase: 'setup' | 'act' | 'assert'
  readonly status: InvariantPhaseStatus
  readonly durationMs: number
  /** If failed, the error message; absent on pass. */
  readonly error?: string
}

/** A single invariant assertion the `assert` phase recorded. */
export interface InvariantAssertion {
  /** Human-readable invariant description. */
  readonly description: string
  /** Whether the invariant held. */
  readonly held: boolean
  /** Optional structured details for diagnostics. */
  readonly details?: Record<string, unknown>
}

/** Outcome payload for an invariant-kind scenario. */
export interface InvariantOutcome {
  /** Doc anchor declared on the scenario (e.g. 'CLAUDE.md#signal-reconciliation/scenario-1'). */
  readonly relatesToInvariant: string
  /** Per-phase status + duration. */
  readonly phases: readonly InvariantPhaseResult[]
  /** Assertion records produced by the `assert` phase. */
  readonly assertions: readonly InvariantAssertion[]
}
