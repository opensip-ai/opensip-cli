// @fitness-ignore-file module-coupling-fan-out -- Package barrel by design: re-exports the public surface of every kind module; fan-out is the whole job of this file
/**
 * @opensip-tools/simulation — Simulation scenarios for codebase analysis.
 *
 * The package exposes two kind-specific scenario authoring entry points
 * sharing one runtime contract:
 *
 *   - `defineLoadScenario`           ← personas + ramp + sustain + assert SLO
 *   - `defineChaosScenario`          ← base load + failure injection + recovery
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
// TOOL PLUGIN — simulation as a Tool implementation
// =============================================================================

// Re-exported as `tool` so the third-party plugin-discovery walker
// (which keys on `mod.tool`) treats first-party and third-party Tool
// packages uniformly; dedup at register-tools.ts handles the
// duplicate-id case.
export { simulationTool, simulationTool as tool } from './tool.js'
// CLI lifecycle surface (mirrors fitness's curated barrel per ADR-0009).
// `executeSim` is NOT here — it lives in `cli/sim.ts` and is not part of the
// public barrel; the CLI drives simulation through the Tool contract
// (`simulationTool`), and sim's own tests import it via the relative
// `cli/sim.js` path. `getPluginLoadErrors` is an internal render/accessor helper
// with no external consumer, so it is exported only from its own module for
// the simulation CLI's relative imports — not re-exported here.
export { ensureScenariosLoaded } from './cli/sim.js'

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
  LoadResultPayload,
} from './types/framework-types.js'
