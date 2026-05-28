/**
 * @fileoverview Simulation plugin loader — adapter over core's generic
 * loader.
 *
 * Core owns the discovery, dynamic-import, error-wrap, and log
 * machinery. This file supplies the sim-specific `registerExports`
 * callback that knows how to interpret a `SimPluginExports`-shaped
 * module: both `scenarios: RunnableScenario[]` and
 * `recipes: SimulationRecipe[]` are explicit arrays — the loader walks
 * each and registers items into the simulation registries. There is no
 * import-side-effect channel.
 *
 * Public API: `loadAllSimPlugins(projectDir)` — the sim equivalent of
 * fitness's `loadAllPlugins('fit', projectDir)`.
 */

import { loadAllPlugins } from '@opensip-tools/core'

import { currentScenarioRegistry } from '../framework/registry.js'
import { currentSimulationRecipeRegistry } from '../recipes/registry.js'

import type { SimPluginExports } from './types.js'
import type { RunnableScenario } from '../framework/runnable-scenario.js'
import type { SimulationRecipe } from '../recipes/types.js'
import type {
  PluginLoadResult,
  RegisterCounts,
  RegisterCtx,
} from '@opensip-tools/core'

/** Register one recipe; returns true if newly registered. Duplicate
 *  recipes throw — caught here and reported as not-newly-registered,
 *  matching the prior behavior of silently skipping duplicates. */
function tryRegisterRecipe(recipe: SimulationRecipe): boolean {
  try {
    currentSimulationRecipeRegistry().register(recipe, { allowOverwrite: false })
    return true
  } catch {
    return false
  }
}

/** Register one scenario; returns true if newly registered. Duplicate
 *  scenarios (same id) silently skip via the registry's
 *  `duplicatePolicy: 'silent-skip'`. A name-collision with a different
 *  id throws — surfaced to the caller as `false`. */
function tryRegisterScenario(scenario: RunnableScenario): boolean {
  const registry = currentScenarioRegistry()
  const before = registry.size
  try {
    registry.register(scenario)
  } catch {
    return false
  }
  return registry.size > before
}

function isValidRecipe(value: unknown): value is SimulationRecipe {
  return value !== null && typeof value === 'object' && 'id' in value && 'name' in value
}

function isValidScenario(value: unknown): value is RunnableScenario {
  return value !== null && typeof value === 'object' && 'id' in value && 'kind' in value && 'run' in value
}

function registerScenariosArray(
  scenariosField: unknown,
  ctx: RegisterCtx,
): number {
  if (scenariosField === undefined) return 0
  if (!Array.isArray(scenariosField)) {
    ctx.warn(
      'plugin.loader.invalid_scenarios_export',
      `Plugin "${ctx.plugin.namespace}" exports "scenarios" but it is not an array — skipping scenario registration.`,
    )
    return 0
  }
  let scenariosRegistered = 0
  for (const [index, scenario] of scenariosField.entries()) {
    if (!isValidScenario(scenario)) {
      ctx.warn(
        'plugin.loader.invalid_scenario_item',
        `Plugin "${ctx.plugin.namespace}" scenarios[${index}] is not a valid RunnableScenario (missing id, kind, or run) — skipping.`,
        { index },
      )
      continue
    }
    if (tryRegisterScenario(scenario)) scenariosRegistered++
  }
  return scenariosRegistered
}

function registerRecipesArray(
  recipesField: unknown,
  ctx: RegisterCtx,
): number {
  if (recipesField === undefined) return 0
  if (!Array.isArray(recipesField)) {
    ctx.warn(
      'plugin.loader.invalid_recipes_export',
      `Plugin "${ctx.plugin.namespace}" exports "recipes" but it is not an array — skipping recipe registration.`,
    )
    return 0
  }
  let recipesRegistered = 0
  for (const [index, recipe] of recipesField.entries()) {
    if (!isValidRecipe(recipe)) {
      ctx.warn(
        'plugin.loader.invalid_recipe_item',
        `Plugin "${ctx.plugin.namespace}" recipes[${index}] is not a valid SimulationRecipe (missing id or name) — skipping.`,
        { index },
      )
      continue
    }
    if (tryRegisterRecipe(recipe)) recipesRegistered++
  }
  return recipesRegistered
}

function registerSimExports(mod: Record<string, unknown>, ctx: RegisterCtx): RegisterCounts {
  const exports = mod as SimPluginExports
  const scenariosRegistered = registerScenariosArray(exports.scenarios, ctx)
  const recipesRegistered = registerRecipesArray(exports.recipes, ctx)
  return { scenariosRegistered, recipesRegistered }
}

/**
 * Discover and load every sim-domain plugin for a project. Plugins
 * are loaded sequentially to keep registration order deterministic.
 *
 * Without `projectDir`, no plugins are discovered — there is no
 * user-global fallback, by design.
 */
export async function loadAllSimPlugins(projectDir?: string): Promise<PluginLoadResult> {
  return loadAllPlugins('sim', projectDir, registerSimExports)
}
