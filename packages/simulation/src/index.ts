/**
 * @opensip-tools/simulation — Simulation scenarios for codebase analysis.
 *
 * Per Plan 01 Phase 0b.5 / DEC-338, the package will expose four kind-specific
 * scenario authoring entry points sharing one runtime contract. This commit
 * lands the foundation + the load kind; subsequent commits add the chaos,
 * invariant, and fix-evaluation kinds.
 *
 *   - `defineLoadScenario`           ← personas + ramp + sustain + assert SLO
 *   - `defineChaosScenario`          (added in a follow-up commit)
 *   - `defineInvariantScenario`      (added in a follow-up commit)
 *   - `defineFixEvaluationScenario`  (added in a follow-up commit)
 *
 * The legacy `defineScenario` is preserved as a one-release deprecation alias
 * that routes to `defineLoadScenario`.
 */

// =============================================================================
// KIND DISCRIMINATOR
// =============================================================================

export type { ScenarioKind } from './types/kind-types.js'
export { SCENARIO_KINDS } from './types/kind-types.js'

// =============================================================================
// SHARED RUNTIME CONTRACT
// =============================================================================

export type { RunnableScenario, ScenarioRegistryEntry } from './framework/runnable-scenario.js'
export type {
  ScenarioExecutorResult,
  LoadScenarioExecutorResult,
} from './framework/scenario-executor-result.js'

// =============================================================================
// REGISTRY
// =============================================================================

export {
  scenarioRegistry,
  getRegisteredScenarios,
  getScenario,
  getScenariosByTag,
  getScenariosByKind,
  clearScenarioRegistry,
} from './framework/registry.js'

export { GenericRegistry, type Registerable } from './framework/generic-registry.js'

// =============================================================================
// LOAD KIND
// =============================================================================

export {
  defineLoadScenario,
  defineLoadScenarioWithoutRegistration,
  validateLoadScenarioConfig,
  type LoadScenarioConfig,
  type LoadValidationError,
} from './kinds/load/define.js'
export type { LoadOutcome } from './kinds/load/result.js'

// =============================================================================
// LEGACY ALIAS (DEPRECATED — one release notice)
// =============================================================================

export {
  /** @deprecated Use `defineLoadScenario`. */
  defineScenario,
  /** @deprecated Use `defineLoadScenarioWithoutRegistration`. */
  defineScenarioWithoutRegistration,
} from './framework/define-scenario.js'

// =============================================================================
// SHARED INFRASTRUCTURE (assertions, personas, result-builder, exec engine)
// =============================================================================

export {
  ASSERTIONS,
  type AssertionFactory,
  evaluateAssertion,
  evaluateOperator,
  getOperatorDescription,
} from './framework/assertions.js'

export {
  persona,
  type PersonaOptions,
  PERSONAS,
  type PersonaPresets,
  getTotalPersonaCount,
  getEstimatedRps,
  getPersonaTypes,
} from './framework/personas.js'

export {
  ScenarioResultBuilder,
  createEmptyMetrics,
  mergeMetrics,
} from './framework/result-builder.js'

export {
  ScenarioAbortedError,
  type ScenarioMetadata,
  type ExecutorScenarioConfig,
  type ExecutorContext,
  type ExecutorLogger,
  type ExecutorResult,
  type ScenarioExecutor,
  type CreateScenarioOptions,
  type ExecutorRunnableScenario,
  type SimulationLoopOptions,
  type SimulationLoopResult,
  type StandardExecutorConfig,
  type EmitSignalInput,
  createScenario,
  createStandardExecutor,
  scenarioAborted,
  validateAssertions,
  getMetricValue,
  updateLatencyMetrics,
  sleepWithAbort,
  runSimulationLoop,
  createExecutorResult,
  emitSimulationSignal,
} from './framework/execution/execution-engine.js'

// =============================================================================
// LEGACY TYPES (load-shaped, retained for `defineScenario`)
// =============================================================================

export type {
  AssertionOperator,
  ScenarioAssertion,
  FailedAssertion,
  PersonaConfig,
  ScenarioExecutionContext,
  ScenarioLogger,
  /** @deprecated Use the discriminated `ScenarioExecutorResult` instead — this name now points at the legacy load-shaped payload. */
  LegacyLoadResultPayload,
  CustomExecuteFn,
  ActionExecutorFn,
  ScenarioExecutionOptions,
  /** @deprecated Use the kind-specific config interfaces. */
  ScenarioConfig,
  PersonaType,
  ScenarioType,
  ChaosConfig,
  SimulationMetrics,
} from './types/framework-types.js'
