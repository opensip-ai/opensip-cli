/**
 * @opensip-tools/simulation — Simulation scenarios for codebase analysis.
 *
 * Per Plan 01 Phase 0b.5 / DEC-338, the package exposes four kind-specific
 * scenario authoring entry points sharing one runtime contract:
 *
 *   - `defineLoadScenario`           ← personas + ramp + sustain + assert SLO
 *   - `defineChaosScenario`          ← base load + failure injection + recovery
 *   - `defineInvariantScenario`      ← seed → act → assert state
 *   - `defineFixEvaluationScenario`  ← run agent against signal → score predicate
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
  ChaosScenarioExecutorResult,
  InvariantScenarioExecutorResult,
  FixEvaluationScenarioExecutorResult,
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
// CHAOS KIND
// =============================================================================

export {
  defineChaosScenario,
  defineChaosScenarioWithoutRegistration,
  validateChaosScenarioConfig,
  type ChaosScenarioConfig,
  type ChaosValidationError,
} from './kinds/chaos/define.js'
export type { ChaosOutcome, ChaosEvent, ChaosAssertionVerdict } from './kinds/chaos/result.js'

// =============================================================================
// INVARIANT KIND
// =============================================================================

export {
  defineInvariantScenario,
  defineInvariantScenarioWithoutRegistration,
  validateInvariantScenarioConfig,
  type InvariantScenarioConfig,
  type InvariantValidationError,
} from './kinds/invariant/define.js'
export type {
  InvariantContext,
  InvariantContextDeps,
} from './kinds/invariant/context.js'
export type {
  InvariantOutcome,
  InvariantPhaseResult,
  InvariantPhaseStatus,
  InvariantAssertion,
} from './kinds/invariant/result.js'

// =============================================================================
// FIX-EVALUATION KIND
// =============================================================================

export {
  defineFixEvaluationScenario,
  defineFixEvaluationScenarioWithoutRegistration,
  validateFixEvaluationScenarioConfig,
  type FixEvaluationScenarioConfig,
  type FixEvaluationValidationError,
  type PredicateComposition,
  type PredicateLeaf,
  type SignalPayload,
} from './kinds/fix-evaluation/define.js'
export type {
  FixEvaluationOutcome,
  PredicateLeafVerdict,
  PredicateCompositeVerdict,
  PredicateVerdict,
  AgentRunSummary,
} from './kinds/fix-evaluation/result.js'
export {
  predicateRegistry,
  registerPredicate,
  getPredicate,
  listPredicateIds,
  resetPredicateRegistryToBaseline,
  type PredicateEvaluator,
  type PredicateEvaluationContext,
  type PredicateEvaluationResult,
  type PredicateArgs,
} from './kinds/fix-evaluation/predicates/index.js'

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
// TOOL PLUGIN — simulation as a Tool implementation
// =============================================================================

export { simulationTool } from './tool.js'
export { executeSim } from './cli/sim.js'

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
  resolveMetric,
  type ScenarioMetricKey,
} from './framework/resolve-metric.js'

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
  updateLatencyMetrics,
  sleepWithAbort,
  runSimulationLoop,
  createExecutorResult,
  emitSimulationSignal,
} from './framework/execution/execution-engine.js'

// =============================================================================
// RECIPES — sim recipes mirror the fitness recipe shape
// =============================================================================

export { defineSimulationRecipe } from './recipes/define-recipe.js'
export {
  SimulationRecipeRegistry,
  defaultSimulationRecipeRegistry,
} from './recipes/registry.js'
export type { SimulationRecipeDisplayInfo } from './recipes/registry.js'
export {
  builtInSimulationRecipes,
  builtInSimulationRecipesByName,
  isBuiltInSimulationRecipe,
} from './recipes/built-in-recipes.js'
export {
  SimulationRecipeService,
} from './recipes/service.js'
export type {
  SimulationRecipeServiceConfig,
  SimulationScenarioResult,
  SimulationRecipeResult,
} from './recipes/service.js'
export type {
  SimulationRecipe,
  SimulationRecipeConfig,
  SimulationExecutionOptions,
  ScenarioSelector,
  ExplicitScenarioSelector,
  AllScenarioSelector,
  TagsScenarioSelector,
  KindScenarioSelector,
} from './recipes/types.js'

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
