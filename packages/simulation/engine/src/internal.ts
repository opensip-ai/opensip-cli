/**
 * @opensip-cli/simulation/internal
 *
 * Internal simulation engine seams (registry/lifecycle/recipe plumbing). This
 * entrypoint is excluded from the root barrel (`@opensip-cli/simulation`) but is
 * deliberately published as an explicit `./internal` subpath export for
 * package-owned and cross-package tests (ADR-0009). Sibling production code is
 * unsupported here and must use `@opensip-cli/simulation` and the Tool contract;
 * dependency-cruiser enforces that boundary.
 */

export { ensureScenariosLoaded } from './cli/sim.js';

export {
  createScenarioRegistry,
  currentScenarioRegistry,
  getRegisteredScenarios,
  getScenario,
  getScenariosByTag,
  getScenariosByKind,
  clearScenarioRegistry,
} from './framework/registry.js';

export { loadAllSimPlugins } from './plugins/loader.js';
export type { SimPluginExports } from './plugins/types.js';

export {
  builtInSimulationRecipes,
  builtInSimulationRecipesByName,
  isBuiltInSimulationRecipe,
} from './recipes/built-in-recipes.js';
export {
  SimulationRecipeRegistry,
  createSimulationRecipeRegistry,
  currentSimulationRecipeRegistry,
} from './recipes/registry.js';
export type { SimulationRecipeDisplayInfo } from './recipes/registry.js';
export { SimulationRecipeService } from './recipes/service.js';
export type {
  SimulationRecipeServiceConfig,
  SimulationScenarioResult,
  SimulationRecipeResult,
} from './recipes/service.js';
