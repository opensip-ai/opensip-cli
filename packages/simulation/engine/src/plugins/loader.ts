/**
 * @fileoverview Simulation plugin loader — adapter over core's generic
 * loader.
 *
 * Core owns the discovery, dynamic-import, error-wrap, and log
 * machinery. This file supplies the sim-specific `registerExports`
 * callback that knows how to interpret a `SimPluginExports`-shaped
 * module:
 *
 *   - Scenarios self-register into `scenarioRegistry` at module
 *     import time (each `defineLoadScenario({...})`, `defineChaosScenario`,
 *     etc. call registers as a side effect of construction). The
 *     loader doesn't need to look at any exported `scenarios` array —
 *     core's `import()` runs first, scenarios are already in the
 *     registry by the time the callback fires.
 *
 *   - Recipes do not self-register, so a `recipes: SimulationRecipe[]`
 *     array on the module is registered explicitly into
 *     `defaultSimulationRecipeRegistry`. Mirrors fitness's recipe
 *     registration path.
 *
 * Per-plugin scenario counts come from snapshotting `scenarioRegistry.size`
 * around each `coreLoadPlugin` call rather than inside the callback —
 * because core imports before invoking the callback, the inside-callback
 * delta is always zero. The outside-snapshot pattern is the price of
 * the side-effect registration design we picked.
 *
 * Public API: `loadAllSimPlugins(projectDir)` — the sim equivalent of
 * fitness's `loadAllPlugins('fit', projectDir)`.
 */

import { discoverPlugins, loadPlugin as coreLoadPlugin } from '@opensip-tools/core'

import { scenarioRegistry } from '../framework/registry.js'
import { defaultSimulationRecipeRegistry } from '../recipes/registry.js'

import type { SimPluginExports } from './types.js'
import type { SimulationRecipe } from '../recipes/types.js'
import type {
  LoadedPlugin,
  PluginLoadResult,
  RegisterCounts,
  RegisterCtx,
} from '@opensip-tools/core'

/**
 * Register a sim plugin's recipes. Scenarios are NOT handled here —
 * they self-register on import (which has already happened by the time
 * core invokes this callback). The caller measures the scenario-count
 * delta outside this function; we return only `recipesRegistered`.
 */
/** Register one recipe; returns true if newly registered. Duplicate
 *  recipes silently skip, matching fitness's behavior. */
function tryRegisterRecipe(recipe: SimulationRecipe): boolean {
  try {
    defaultSimulationRecipeRegistry.register(recipe, { allowOverwrite: false })
    return true
  } catch {
    return false
  }
}

function isValidRecipe(value: unknown): value is SimulationRecipe {
  return value !== null && typeof value === 'object' && 'id' in value && 'name' in value
}

function registerSimExports(mod: Record<string, unknown>, ctx: RegisterCtx): RegisterCounts {
  const recipesField = (mod as SimPluginExports).recipes
  let recipesRegistered = 0

  if (recipesField === undefined) {
    // scenariosRegistered intentionally omitted — measured outside.
    return { recipesRegistered }
  }

  if (!Array.isArray(recipesField)) {
    ctx.warn(
      'plugin.loader.invalid_recipes_export',
      `Plugin "${ctx.plugin.namespace}" exports "recipes" but it is not an array — skipping recipe registration.`,
    )
    return { recipesRegistered }
  }

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

  return { recipesRegistered }
}

/**
 * Discover and load every sim-domain plugin for a project. Plugins
 * are loaded sequentially to keep registration order deterministic.
 *
 * Without `projectDir`, no plugins are discovered — there is no
 * user-global fallback, by design.
 *
 * Re-implements the outer loop from core's `loadAllPlugins` so we can
 * snapshot `scenarioRegistry.size` around each per-plugin import.
 * Core's `loadAllPlugins` runs the import inside `coreLoadPlugin`
 * before invoking our callback, so the only place we can observe the
 * size delta is around the `coreLoadPlugin` call itself.
 */
export async function loadAllSimPlugins(projectDir?: string): Promise<PluginLoadResult> {
  const discovered = discoverPlugins('sim', projectDir)

  const plugins: LoadedPlugin[] = []
  const errors: string[] = []

  for (const plugin of discovered) {
    const sizeBefore = scenarioRegistry.size
    const result = await coreLoadPlugin(plugin, registerSimExports)
    const scenariosRegistered = scenarioRegistry.size - sizeBefore

    // Inject the externally-measured scenario count. core's loadPlugin
    // doesn't know about scenarios, so it returned 0 for that field —
    // we patch it here before rolling up totals.
    const patched: LoadedPlugin = {
      ...result,
      scenariosRegistered,
    }
    plugins.push(patched)
    if (patched.error) {
      errors.push(`${patched.source}: ${patched.error}`)
    }
  }

  return {
    plugins,
    totalChecks: plugins.reduce((sum, p) => sum + p.checksRegistered, 0),
    totalRecipes: plugins.reduce((sum, p) => sum + p.recipesRegistered, 0),
    totalAdapters: plugins.reduce((sum, p) => sum + (p.adaptersRegistered ?? 0), 0),
    totalScenarios: plugins.reduce((sum, p) => sum + (p.scenariosRegistered ?? 0), 0),
    errors,
  }
}
