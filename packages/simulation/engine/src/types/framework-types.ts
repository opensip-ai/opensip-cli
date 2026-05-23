/**
 * @fileoverview Cross-kind type definitions for the Simulation Framework.
 *
 * Per Plan 01 Phase 0b.5, the framework now exposes four kind-specific entry
 * points (`defineLoadScenario`, `defineChaosScenario`, `defineInvariantScenario`,
 * `defineFixEvaluationScenario`). The discriminated union over kinds lives in
 * `framework/scenario-executor-result.ts`; the cross-kind `RunnableScenario`
 * lives in `framework/runnable-scenario.ts`.
 *
 * The exports below are the small set of cross-kind shapes that each kind's
 * `define`/`executor`/`result` modules consume — execution context + logger,
 * persona config, assertion + failed-assertion shapes, the legacy load result
 * payload (still produced by `ScenarioResultBuilder`), and the optional
 * custom-`execute` hook.
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
// PERSONA TYPES
// =============================================================================

/**
 * Configuration for a persona in a scenario (readonly variant for framework use).
 */
export interface PersonaConfig {
  readonly personaId: string
  readonly count: number
  readonly spawnRate: number
  readonly actions: readonly string[]
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
 * Legacy load-shaped scenario result payload, produced by `ScenarioResultBuilder`.
 *
 * The new public `ScenarioExecutorResult` (discriminated union over kinds)
 * lives in `framework/scenario-executor-result.ts`. Each kind's runner wraps
 * a payload of this shape into its kind-specific envelope.
 *
 * @deprecated Prefer the discriminated `ScenarioExecutorResult` from
 * `framework/scenario-executor-result.ts`.
 */
export interface LegacyLoadResultPayload {
  readonly passed: boolean
  readonly metrics: SimulationMetrics
  readonly assertions: {
    readonly passed: readonly ScenarioAssertion[]
    readonly failed: readonly FailedAssertion[]
  }
  readonly signals: readonly Signal[]
}

/**
 * Custom execute function signature for load scenarios.
 *
 * Custom execute functions return the legacy load result payload; the
 * load runner wraps the payload into a `LoadScenarioExecutorResult`.
 */
// eslint-disable-next-line sonarjs/deprecation -- the legacy custom-execute hook returns the legacy payload by design
export type CustomExecuteFn = (context: ScenarioExecutionContext) => Promise<LegacyLoadResultPayload>

// =============================================================================
// RE-EXPORTS
// =============================================================================

export { type ScenarioType, type AssertionOperator, type PersonaType, type ChaosConfig, type SimulationMetrics } from './base-types.js'
