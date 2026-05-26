/**
 * @fileoverview Simulation plugin export contract
 *
 * What an @opensip-tools/scenarios-* (or any sim-domain plugin) exports.
 *
 * Unlike fitness's check packages, sim scenarios *self-register* into
 * `scenarioRegistry` as a side effect of being defined — every
 * `defineLoadScenario({...})`, `defineChaosScenario({...})`, etc. call
 * registers the scenario as it constructs it. A scenario package
 * therefore doesn't need to export a `scenarios: [...]` array; the act
 * of importing the module is enough.
 *
 * Recipes are different: they don't self-register, so a scenario
 * package that ships custom recipes exports them in a `recipes` array
 * and the sim loader registers them explicitly.
 */

import type { SimulationRecipe } from '../recipes/types.js'
import type { PluginMetadata } from '@opensip-tools/core'

/** What a sim plugin package/file exports. */
export interface SimPluginExports {
  readonly recipes?: readonly SimulationRecipe[]
  readonly metadata?: PluginMetadata
}
