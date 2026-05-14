// @fitness-ignore-file batch-operation-limits -- iterates bounded collections (config entries, registry items, or small analysis results)
/**
 * @fileoverview Simulation recipe registry
 *
 * Uses GenericRegistry for dual-key (id + name) lookup with tag filtering.
 */

import { GenericRegistry, type Registerable } from '../framework/generic-registry.js'

import type { SimulationRecipe } from './recipe-types.js'

// SimulationRecipe satisfies Registerable (id, name, tags)
/** Shared registry for simulation recipes with dual-key (id + name) lookup */
export const recipeRegistry = new GenericRegistry<SimulationRecipe & Registerable>('simulation.recipes')

/** Retrieve a simulation recipe by ID or name */
export function getRecipe(idOrName: string): SimulationRecipe | undefined {
  return recipeRegistry.get(idOrName)
}

/** Return all registered simulation recipes */
export function getAllRecipes(): SimulationRecipe[] {
  return recipeRegistry.getAll()
}

/** Return all simulation recipes matching a given tag */
export function getRecipesByTag(tag: string): SimulationRecipe[] {
  return recipeRegistry.getByTag(tag)
}
