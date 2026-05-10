/**
 * @fileoverview Simulation Framework — shared infrastructure.
 *
 * Per Plan 01 Phase 0b.5 / DEC-338, scenario authoring goes through one of the
 * four kind-specific entry points exported from the package root:
 *
 *   - `defineLoadScenario`           ← personas + ramp + assertions (existing)
 *   - `defineChaosScenario`          ← base load + failure injection
 *   - `defineInvariantScenario`      ← seed → act → assert
 *   - `defineFixEvaluationScenario`  ← run agent against signal → score predicate
 *
 * The framework module exports the cross-kind shared infrastructure: the
 * registry, the runnable contract, the discriminated result union, helpers
 * shared between load + chaos kinds (personas, assertions, result-builder),
 * and the abort/log/correlation execution engine.
 */

// =============================================================================
// LEGACY TYPES (load-shaped, retained for back-compat with `defineScenario`)
// =============================================================================

export type {
  // Assertion types
  AssertionOperator,
  ScenarioAssertion,
  FailedAssertion,

  // Persona types
  PersonaConfig,

  // Executor types
  ScenarioExecutionContext,
  ScenarioLogger,
  /** @deprecated Alias for {@link LegacyLoadResultPayload}. The discriminated result type is exported from the package root. */
  ScenarioExecutorResult,
  LegacyLoadResultPayload,
  CustomExecuteFn,
  ActionExecutorFn,

  // Config types
  ScenarioExecutionOptions,
  /** @deprecated Use the kind-specific `LoadScenarioConfig` / `ChaosScenarioConfig` / etc. */
  ScenarioConfig,

  // Re-exports from base-types
  PersonaType,
  ScenarioType,
  ChaosConfig,
  SimulationMetrics,
} from '../types/framework-types.js'

// =============================================================================
// KIND DISCRIMINATOR
// =============================================================================

export type { ScenarioKind } from '../types/kind-types.js'
export { SCENARIO_KINDS } from '../types/kind-types.js'

// =============================================================================
// SHARED RUNTIME CONTRACT
// =============================================================================

export type { RunnableScenario, ScenarioRegistryEntry } from './runnable-scenario.js'
export type {
  ScenarioExecutorResult as KindAwareScenarioExecutorResult,
  LoadScenarioExecutorResult,
  ChaosScenarioExecutorResult,
  InvariantScenarioExecutorResult,
} from './scenario-executor-result.js'

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
} from './registry.js'

// =============================================================================
// ASSERTIONS (load + chaos shared)
// =============================================================================

export {
  ASSERTIONS,
  type AssertionFactory,
  evaluateAssertion,
  evaluateOperator,
  getOperatorDescription,
} from './assertions.js'

// =============================================================================
// PERSONAS (load + chaos shared)
// =============================================================================

export {
  persona,
  type PersonaOptions,
  PERSONAS,
  type PersonaPresets,
  getTotalPersonaCount,
  getEstimatedRps,
  getPersonaTypes,
} from './personas.js'

// =============================================================================
// RESULT BUILDER (load + chaos shared)
// =============================================================================

export { ScenarioResultBuilder, createEmptyMetrics, mergeMetrics } from './result-builder.js'

// =============================================================================
// GENERIC REGISTRY PRIMITIVE
// =============================================================================

export { GenericRegistry, type Registerable } from './generic-registry.js'

// =============================================================================
// LEGACY DEFINE-SCENARIO ALIAS
// =============================================================================

export {
  /** @deprecated Use `defineLoadScenario` from '@opensip-tools/simulation'. */
  defineScenario,
  /** @deprecated Use `defineLoadScenarioWithoutRegistration` from '@opensip-tools/simulation'. */
  defineScenarioWithoutRegistration,
  /** @deprecated Use `validateLoadScenarioConfig` from '@opensip-tools/simulation/kinds/load'. */
  validateScenarioConfig,
  type ValidationError,
} from './define-scenario.js'

// =============================================================================
// VALIDATION
// =============================================================================

export {
  type ScenarioValidationError,
  type ScenarioValidationResult,
  validateScenario,
  validateScenarios,
  formatScenarioValidationResult,
} from './validation/scenario-validator.js'

// =============================================================================
// EXECUTION ENGINE (shared abort / log / correlation infra)
// =============================================================================

export {
  // Error class
  ScenarioAbortedError,

  // Types
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

  // Factory functions
  createScenario,
  createStandardExecutor,

  // Utility functions
  scenarioAborted,
  validateAssertions,
  getMetricValue,
  updateLatencyMetrics,
  sleepWithAbort,
  runSimulationLoop,
  createExecutorResult,
  emitSimulationSignal,
} from './execution/execution-engine.js'

export {
  type SimulationActionResult,
  type ChaosResult,
  type SimulationLoopContext,
  applyChaos,
} from './execution/action-handlers.js'

export { LatencyTracker } from './execution/latency-tracker.js'

// =============================================================================
// BASE TYPES (from types/)
// =============================================================================

export type {
  PersonaBehavior,
  Persona,
  PersonaAttributes,
  ActionProbabilities,
  SimulationScenario,
  ChaosType,
  ChaosInjection,
  ChaosTypeConfig,
  LatencyChaosConfig,
  ErrorChaosConfig,
  TimeoutChaosConfig,
  RateLimitChaosConfig,
  ConnectionDropChaosConfig,
  DataCorruptionChaosConfig,
  ExecutionMode,
  SimulationRunStatus,
  SimulationRun,
  ListRunsOptions,
  ISimulationService,
} from '../types/base-types.js'
