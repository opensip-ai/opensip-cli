/**
 * @fileoverview Cross-kind type definitions for the Simulation Framework.
 *
 * The framework exposes two kind-specific entry points (`defineLoadScenario`,
 * `defineChaosScenario`). The discriminated union over kinds lives in
 * `framework/scenario-executor-result.ts`; the cross-kind `RunnableScenario`
 * lives in `framework/runnable-scenario.ts`.
 *
 * The exports below are the small set of cross-kind shapes that each kind's
 * `define`/`executor`/`result` modules consume — execution context + logger,
 * assertion + failed-assertion shapes, and the load result payload (produced by
 * `ScenarioResultBuilder`).
 */

import type {
  SimulationMetrics,
  ScenarioAssertion as MutableScenarioAssertion,
} from './base-types.js'
import type { Signal } from '@opensip-tools/core'


// =============================================================================
// ASSERTION TYPES
// =============================================================================

/**
 * A scenario assertion definition (readonly variant for framework use).
 */
export type ScenarioAssertion = Readonly<MutableScenarioAssertion>

/**
 * A failed assertion with actual value.
 */
export interface FailedAssertion extends ScenarioAssertion {
  readonly actual: number
}

// =============================================================================
// EXECUTOR TYPES
// =============================================================================

/**
 * Context passed to scenario executors.
 */
export interface ScenarioExecutionContext {
  readonly scenarioId: string
  readonly correlationId: string
  readonly abortSignal: AbortSignal
  readonly logger: ScenarioLogger
}

/**
 * Logger interface for scenarios.
 */
export interface ScenarioLogger {
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
  debug(message: string, data?: Record<string, unknown>): void
}

/**
 * Load-shaped scenario result payload, produced by `ScenarioResultBuilder`.
 *
 * This is the builder's output shape: the load and chaos executors build a
 * payload of this shape and wrap it into their kind-specific
 * `ScenarioExecutorResult` envelope (the discriminated union over kinds in
 * `framework/scenario-executor-result.ts`).
 */
export interface LoadResultPayload {
  readonly passed: boolean
  readonly metrics: SimulationMetrics
  readonly assertions: {
    readonly passed: readonly ScenarioAssertion[]
    readonly failed: readonly FailedAssertion[]
  }
  readonly signals: readonly Signal[]
}

// =============================================================================
// RE-EXPORTS
// =============================================================================

export { type AssertionOperator, type SimulationMetrics } from './base-types.js'
