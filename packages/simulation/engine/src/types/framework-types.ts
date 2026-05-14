/**
 * @fileoverview Legacy type definitions for the Simulation Framework.
 *
 * Per Plan 01 Phase 0b.5, the framework now exposes four kind-specific entry
 * points (`defineLoadScenario`, `defineChaosScenario`, `defineInvariantScenario`,
 * `defineFixEvaluationScenario`). The discriminated union over kinds lives in
 * `framework/scenario-executor-result.ts`; the cross-kind `RunnableScenario`
 * lives in `framework/runnable-scenario.ts`.
 *
 * The exports below preserve the legacy shapes so callers using `defineScenario`
 * (the deprecated alias for `defineLoadScenario`) continue to compile.
 *
 * @deprecated Prefer the new kind-specific types from `kinds/<kind>/define.ts`.
 */

import type {
  
  ScenarioType,
  ChaosConfig,
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

/**
 * Action executor function signature.
 */
export type ActionExecutorFn = (action: string, context: ScenarioExecutionContext) => Promise<void>

// =============================================================================
// SCENARIO CONFIG
// =============================================================================

/**
 * Options for scenario execution.
 */
export interface ScenarioExecutionOptions {
  readonly persistReports?: boolean
  readonly persistLogs?: boolean
}

/**
 * Full scenario configuration.
 * This is what scenario authors provide to defineScenario().
 */
export interface ScenarioConfig {
  // === Required Metadata ===
  readonly id: string
  readonly name: string
  readonly description: string
  readonly type: ScenarioType
  readonly tags: readonly string[]

  // === Simulation Configuration ===
  readonly personas: readonly PersonaConfig[]
  readonly duration: number
  readonly rampUp?: number
  readonly targetRps?: number

  // === Assertions ===
  readonly assertions: readonly ScenarioAssertion[]

  // === Optional Customization ===
  readonly execute?: CustomExecuteFn
  readonly actionExecutor?: ActionExecutorFn
  readonly chaosConfig?: ChaosConfig

  // === Execution Options ===
  readonly options?: ScenarioExecutionOptions
}

// =============================================================================
// RUNNABLE SCENARIO
// =============================================================================

// `RunnableScenario` is now defined in `framework/runnable-scenario.ts` and
// carries a `kind` discriminator. The legacy load-only interface that lived
// here (with `type: ScenarioType` + `getConfig()`) was retired by Plan 01
// Phase 0b.5 — there were no external consumers of `getConfig()`, and `type`
// was redundant with the new `kind` discriminator.

// =============================================================================
// RE-EXPORTS
// =============================================================================



export {type ScenarioType, type AssertionOperator, type PersonaType, type ChaosConfig, type SimulationMetrics} from './base-types.js'