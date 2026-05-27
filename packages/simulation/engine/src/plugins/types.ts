/**
 * @fileoverview Simulation plugin export contract
 *
 * What an @opensip-tools/scenarios-* (or any sim-domain plugin) exports.
 *
 * Both scenarios and recipes are registered explicitly by the
 * simulation plugin loader — `defineLoadScenario({...})`,
 * `defineChaosScenario({...})`, etc. return scenario objects without
 * touching any registry. A scenario plugin therefore exports a
 * `scenarios: [...]` array containing the results of each `defineX`
 * call, and the loader walks the array to register them into the
 * current scope's scenario registry.
 *
 * Recipes follow the same pattern: a `recipes` array on the module is
 * registered by the loader.
 */

import type { RunnableScenario } from '../framework/runnable-scenario.js'
import type { SimulationRecipe } from '../recipes/types.js'

/** What a sim plugin package/file exports. */
export interface SimPluginExports {
  readonly scenarios?: readonly RunnableScenario[]
  readonly recipes?: readonly SimulationRecipe[]
}
