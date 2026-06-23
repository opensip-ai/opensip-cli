/**
 * @opensip-cli/simulation — Simulation scenarios for codebase analysis.
 *
 * The package exposes two kind-specific scenario authoring entry points
 * sharing one runtime contract:
 *
 *   - `defineLoadScenario`           ← BYO target + workload + assert SLO
 *   - `defineChaosScenario`          ← BYO target + client-side faults + recovery
 */

// =============================================================================
// RUNSCOPE AUGMENTATION — D7 (tool subscopes via module augmentation).
// Side-effect import so importing the simulation package surfaces
// `scope.simulation` on the augmented RunScope interface.
// =============================================================================

import './scope-augmentation.js';
export type { SimulationSubscope } from './scope-augmentation.js';

// =============================================================================
// KIND DISCRIMINATOR
// =============================================================================

export type { ScenarioKind } from './types/kind-types.js';
export { SCENARIO_KINDS } from './types/kind-types.js';

// =============================================================================
// SHARED RUNTIME CONTRACT
// =============================================================================

export type { RunnableScenario, ScenarioRegistryEntry } from './framework/runnable-scenario.js';
export type {
  ScenarioExecutorResult,
  LoadScenarioExecutorResult,
  ChaosScenarioExecutorResult,
} from './framework/scenario-executor-result.js';

// =============================================================================
// LOAD KIND
// =============================================================================

export {
  defineLoadScenario,
  validateLoadScenarioConfig,
  type LoadScenarioConfig,
} from './kinds/load/define.js';
export type { LoadOutcome } from './kinds/load/result.js';

// =============================================================================
// CHAOS KIND
// =============================================================================

export {
  defineChaosScenario,
  validateChaosScenarioConfig,
  type ChaosScenarioConfig,
} from './kinds/chaos/define.js';
export type { ChaosOutcome, ChaosEvent, ChaosAssertionVerdict } from './kinds/chaos/result.js';

// =============================================================================
// TOOL PLUGIN — simulation as a Tool implementation
// =============================================================================

// Re-exported as `tool` so the third-party plugin-discovery walker
// (which keys on `mod.tool`) treats first-party and third-party Tool
// packages uniformly; dedup at register-tools.ts handles the
// duplicate-id case.
export { simulationTool, simulationTool as tool } from './tool.js';
export { SIMULATION_CONTRACT_VERSION } from './tool.js';
// CLI lifecycle helpers intentionally stay off the public barrel.
// `executeSim` is NOT here — it lives in `cli/sim.ts` and is not part of the
// public barrel; the CLI drives simulation through the Tool contract
// (`simulationTool`), and sim's own tests import lifecycle helpers through
// relative paths or `@opensip-cli/simulation/internal`.

// =============================================================================
// PLUGIN DISCOVERY — sim plugin contract + @opensip-cli/scenarios-*
// =============================================================================

export type { SimPluginExports } from './plugins/types.js';

// =============================================================================
// SHARED INFRASTRUCTURE
// =============================================================================
// Authoring helpers (assertions, BYO target + fault builders) and runtime
// utilities (result builder, metric resolver, abort/sleep helpers) shared by
// every kind.

export {
  ASSERTIONS,
  type AssertionFactory,
  evaluateAssertion,
  evaluateOperator,
  getOperatorDescription,
} from './framework/assertions.js';

// BYO-target authoring surface: the `Target` seam, the neutral workload, and
// the client-side fault vocabulary + ergonomic builders.
export { httpTarget, type HttpTargetOptions } from './framework/execution/http-target.js';
export { fault } from './framework/execution/fault-builders.js';
export type { Target, TargetContext } from './framework/execution/target.js';
export type { Workload } from './types/workload.js';
export type { Fault, FaultKind, FaultSpec } from './framework/execution/fault-spec.js';

export {
  ScenarioResultBuilder,
  createEmptyMetrics,
  mergeMetrics,
} from './framework/result-builder.js';

export { resolveMetric, type ScenarioMetricKey } from './framework/resolve-metric.js';

export {
  ScenarioAbortedError,
  scenarioAborted,
  validateAssertions,
  updateLatencyMetrics,
  sleepWithAbort,
} from './framework/execution/execution-engine.js';

// =============================================================================
// RECIPES — sim recipes mirror the fitness recipe shape
// =============================================================================

export { defineSimulationRecipe } from './recipes/define-recipe.js';
export type {
  SimulationRecipe,
  SimulationRecipeConfig,
  SimulationExecutionOptions,
  ScenarioSelector,
  ExplicitScenarioSelector,
  AllScenarioSelector,
  TagsScenarioSelector,
  KindScenarioSelector,
} from './recipes/types.js';

// =============================================================================
// CROSS-KIND TYPES (shared by every kind's define/executor/result modules)
// =============================================================================

export type {
  AssertionOperator,
  ScenarioAssertion,
  FailedAssertion,
  ScenarioExecutionContext,
  ScenarioLogger,
  SimulationMetrics,
  LoadResultPayload,
} from './types/framework-types.js';
