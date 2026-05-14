/**
 * @fileoverview Chaos-kind result outcome.
 *
 * The chaos kind composes a load run with explicit failure injection +
 * recovery assertions. The outcome carries:
 *   - the load metrics during the steady-state phase
 *   - the steady-state assertion verdicts (held while chaos is active)
 *   - the recovery assertion verdicts (held after chaos lifts)
 *   - the chaos events that fired during the run
 */

import type { SimulationMetrics } from '../../types/base-types.js'
import type {
  ScenarioAssertion,
  FailedAssertion,
} from '../../types/framework-types.js'

/** A single chaos event recorded during the run, for diagnostics. */
export interface ChaosEvent {
  readonly type: 'latency' | 'error' | 'timeout' | 'rate-limit' | 'connection-drop' | 'data-corruption'
  readonly atMs: number
  readonly target: string
}

/** Verdict bundle for a single assertion phase (steady-state OR recovery). */
export interface ChaosAssertionVerdict {
  readonly passed: readonly ScenarioAssertion[]
  readonly failed: readonly FailedAssertion[]
}

/** Outcome payload for a chaos-kind scenario. */
export interface ChaosOutcome {
  /** Aggregated metrics for the steady-state (chaos-active) window. */
  readonly steadyStateMetrics: SimulationMetrics
  /** Aggregated metrics for the recovery window after chaos lifts. */
  readonly recoveryMetrics: SimulationMetrics
  /** Verdicts for the steady-state assertions. */
  readonly steadyStateAssertions: ChaosAssertionVerdict
  /** Verdicts for the recovery assertions. */
  readonly recoveryAssertions: ChaosAssertionVerdict
  /** Chaos events recorded during the run. */
  readonly chaosEvents: readonly ChaosEvent[]
  /** Recovery window in ms after chaos lifts. */
  readonly recoveryWindowMs: number
}
