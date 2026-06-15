/**
 * @opensip-cli/simulation/internal
 *
 * Internal simulation engine seams for package-owned tests and tool integration
 * code that needs registry/lifecycle plumbing. This entrypoint is intentionally
 * excluded from published package exports; production packages must use
 * `@opensip-cli/simulation` and the Tool contract instead.
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
export { readScenarioPackagePreferences } from './plugins/scenario-package-discovery.js';
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
