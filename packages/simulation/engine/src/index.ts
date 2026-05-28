// @fitness-ignore-file no-deprecated-tags -- LegacyLoadResultPayload is the active payload type produced by ScenarioResultBuilder and consumed by load's CustomExecuteFn; the @deprecated tag in the re-export below is a steering hint, not a removal trigger.
// @fitness-ignore-file module-coupling-fan-out -- Package barrel by design: re-exports the public surface of every kind module; fan-out is the whole job of this file
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
 */

// =============================================================================
// RUNSCOPE AUGMENTATION — D7 (tool subscopes via module augmentation).
// Side-effect import so importing the simulation package surfaces
// `scope.simulation` on the augmented RunScope interface.
// =============================================================================

import './scope-augmentation.js'
export type { SimulationSubscope } from './scope-augmentation.js'

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
  createScenarioRegistry,
  currentScenarioRegistry,
  getRegisteredScenarios,
  getScenario,
  getScenariosByTag,
  getScenariosByKind,
  clearScenarioRegistry,
} from './framework/registry.js'

// =============================================================================
// LOAD KIND
// =============================================================================

export {
  defineLoadScenario,
  validateLoadScenarioConfig,
  type LoadScenarioConfig,
} from './kinds/load/define.js'
export type { LoadOutcome } from './kinds/load/result.js'

// =============================================================================
// CHAOS KIND
// =============================================================================

export {
  defineChaosScenario,
  validateChaosScenarioConfig,
  type ChaosScenarioConfig,
} from './kinds/chaos/define.js'
export type { ChaosOutcome, ChaosEvent, ChaosAssertionVerdict } from './kinds/chaos/result.js'

// =============================================================================
// INVARIANT KIND
// =============================================================================

export {
  defineInvariantScenario,
  validateInvariantScenarioConfig,
  type InvariantScenarioConfig,
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
  validateFixEvaluationScenarioConfig,
  type FixEvaluationScenarioConfig,
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
// TOOL PLUGIN — simulation as a Tool implementation
// =============================================================================

// Re-exported as `tool` so the third-party plugin-discovery walker
// (which keys on `mod.tool`) treats first-party and third-party Tool
// packages uniformly; dedup at register-tools.ts handles the
// duplicate-id case.
export { simulationTool, simulationTool as tool } from './tool.js'
export {
  executeSim,
  ensureScenariosLoaded,
  getPluginLoadErrors,
  setPreLoadHook,
} from './cli/sim.js'
export type { PreLoadHook } from './cli/sim.js'

// =============================================================================
// PLUGIN DISCOVERY — sim plugin contract + @opensip-tools/scenarios-*
// =============================================================================

export type { SimPluginExports } from './plugins/types.js'
export {
  discoverScenarioPackages,
  readScenarioPackageMetadata,
  readScenarioPackagePreferences,
} from './plugins/scenario-package-discovery.js'
export type {
  DiscoveredScenarioPackage,
  ScenarioPackageDiscoveryOptions,
  ScenarioPackageMetadata,
} from './plugins/scenario-package-discovery.js'
export { loadAllSimPlugins } from './plugins/loader.js'

// =============================================================================
// SHARED INFRASTRUCTURE
// =============================================================================
// Authoring helpers (assertions, personas) and runtime utilities
// (result builder, metric resolver, abort/sleep helpers) shared by every kind.

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
  scenarioAborted,
  validateAssertions,
  updateLatencyMetrics,
  sleepWithAbort,
} from './framework/execution/execution-engine.js'

// =============================================================================
// RECIPES — sim recipes mirror the fitness recipe shape
// =============================================================================

export { defineSimulationRecipe } from './recipes/define-recipe.js'
export {
  SimulationRecipeRegistry,
  createSimulationRecipeRegistry,
  currentSimulationRecipeRegistry,
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
// CROSS-KIND TYPES (shared by every kind's define/executor/result modules)
// =============================================================================

export type {
  AssertionOperator,
  ScenarioAssertion,
  FailedAssertion,
  PersonaConfig,
  ScenarioExecutionContext,
  ScenarioLogger,
  CustomExecuteFn,
  PersonaType,
  ChaosConfig,
  SimulationMetrics,
  /**
   * @deprecated Held only for back-compat with the prior load-only
   * `ScenarioResultBuilder` payload. Prefer `ScenarioExecutorResult`
   * (the discriminated union over kinds) for new code.
   */
  LegacyLoadResultPayload,
} from './types/framework-types.js'
