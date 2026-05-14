/**
 * @fileoverview Plugin loader — dynamic import and registration
 *
 * Takes discovered plugins, imports them, validates their exports,
 * and registers checks/recipes with namespaces.
 */

import { pathToFileURL } from 'node:url'

import { logger } from '../lib/logger.js'
import { isCheck } from '../framework/check-types.js'
import { defaultRegistry } from '../framework/registry.js'
import { defaultLanguageRegistry } from '../languages/registry.js'
import { defaultRecipeRegistry } from '../recipes/registry.js'

import { discoverPlugins } from './discover.js'
import type {
  DiscoveredPlugin,
  FitPluginExports,
  LangPluginExports,
  LoadedPlugin,
  PluginDomain,
  PluginLoadResult,
} from './types.js'

/**
 * Load a single discovered plugin.
 *
 * For `domain === 'lang'`, the module is expected to export an `adapters`
 * array of LanguageAdapter; each is registered with defaultLanguageRegistry.
 * For other domains, registers checks and recipes with defaultRegistry and
 * defaultRecipeRegistry respectively.
 */
export async function loadPlugin(
  plugin: DiscoveredPlugin,
  domain: PluginDomain = 'fit',
): Promise<LoadedPlugin> {
  try {
    const moduleUrl = pathToFileURL(plugin.entryPoint).href
    const mod = await import(moduleUrl) as FitPluginExports & LangPluginExports

    let checksRegistered = 0
    let recipesRegistered = 0
    let adaptersRegistered = 0

    // Lang domain: register language adapters
    if (domain === 'lang' && mod.adapters !== undefined) {
      if (!Array.isArray(mod.adapters)) {
        logger.warn({
          evt: 'plugin.loader.invalid_adapters_export',
          module: 'core:plugins',
          namespace: plugin.namespace,
          source: plugin.source,
          msg: `Plugin "${plugin.namespace}" exports "adapters" but it is not an array — skipping adapter registration.`,
        })
      } else {
        for (const [index, adapter] of mod.adapters.entries()) {
          if (
            adapter &&
            typeof adapter === 'object' &&
            'id' in adapter &&
            'fileExtensions' in adapter &&
            'parse' in adapter
          ) {
            defaultLanguageRegistry.register(adapter)
            adaptersRegistered++
          } else {
            logger.warn({
              evt: 'plugin.loader.invalid_adapter_item',
              module: 'core:plugins',
              namespace: plugin.namespace,
              source: plugin.source,
              index,
              msg: `Plugin "${plugin.namespace}" adapters[${index}] is not a valid LanguageAdapter — skipping.`,
            })
          }
        }
      }
    }

    // Register checks with namespace (skipped for lang domain)
    if (domain !== 'lang' && mod.checks !== undefined) {
      if (!Array.isArray(mod.checks)) {
        logger.warn({
          evt: 'plugin.loader.invalid_checks_export',
          module: 'core:plugins',
          namespace: plugin.namespace,
          source: plugin.source,
          msg: `Plugin "${plugin.namespace}" exports "checks" but it is not an array — skipping checks registration.`,
        })
      } else {
        for (const [index, check] of mod.checks.entries()) {
          if (isCheck(check)) {
            defaultRegistry.register(check, plugin.namespace)
            checksRegistered++
          } else {
            logger.warn({
              evt: 'plugin.loader.invalid_check_item',
              module: 'core:plugins',
              namespace: plugin.namespace,
              source: plugin.source,
              index,
              msg: `Plugin "${plugin.namespace}" checks[${index}] is not a valid Check object — skipping.`,
            })
          }
        }
      }
    }

    // Register recipes (skipped for lang domain)
    if (domain !== 'lang' && mod.recipes !== undefined) {
      if (!Array.isArray(mod.recipes)) {
        logger.warn({
          evt: 'plugin.loader.invalid_recipes_export',
          module: 'core:plugins',
          namespace: plugin.namespace,
          source: plugin.source,
          msg: `Plugin "${plugin.namespace}" exports "recipes" but it is not an array — skipping recipes registration.`,
        })
      } else {
        for (const [index, recipe] of mod.recipes.entries()) {
          if (recipe && typeof recipe === 'object' && 'id' in recipe && 'name' in recipe) {
            try {
              defaultRecipeRegistry.register(recipe, { allowOverwrite: false })
              recipesRegistered++
            } catch {
              // Duplicate recipe — skip silently
            }
          } else {
            logger.warn({
              evt: 'plugin.loader.invalid_recipe_item',
              module: 'core:plugins',
              namespace: plugin.namespace,
              source: plugin.source,
              index,
              msg: `Plugin "${plugin.namespace}" recipes[${index}] is not a valid Recipe object (missing id or name) — skipping.`,
            })
          }
        }
      }
    }

    const nothingRegistered =
      domain === 'lang'
        ? mod.adapters === undefined
        : mod.checks === undefined && mod.recipes === undefined

    if (nothingRegistered) {
      logger.warn({
        evt: 'plugin.loader.no_exports',
        module: 'core:plugins',
        namespace: plugin.namespace,
        source: plugin.source,
        domain,
        msg:
          domain === 'lang'
            ? `Plugin "${plugin.namespace}" exports no "adapters" — nothing to register.`
            : `Plugin "${plugin.namespace}" exports neither "checks" nor "recipes" — nothing to register.`,
      })
    }

    logger.info({
      evt: 'plugin.loader.load.success',
      module: 'core:plugins',
      namespace: plugin.namespace,
      source: plugin.source,
      domain,
      checksRegistered,
      recipesRegistered,
      adaptersRegistered,
    })

    return {
      namespace: plugin.namespace,
      source: plugin.source,
      type: plugin.type,
      checksRegistered,
      recipesRegistered,
      adaptersRegistered,
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)

    logger.warn({
      evt: 'plugin.loader.load.error',
      module: 'core:plugins',
      namespace: plugin.namespace,
      source: plugin.source,
      error: errorMsg,
      err: err instanceof Error ? err : undefined,
      msg: `Plugin "${plugin.namespace}" failed to load: ${errorMsg}. Continuing without this plugin.`,
    })

    return {
      namespace: plugin.namespace,
      source: plugin.source,
      type: plugin.type,
      checksRegistered: 0,
      recipesRegistered: 0,
      adaptersRegistered: 0,
      error: errorMsg,
    }
  }
}

/**
 * Discover and load all plugins for a domain.
 * Loads sequentially to ensure deterministic registration order.
 *
 * Pass `projectDir` to honor the project's `opensip-tools.config.yml`
 * `plugins.<domain>` declaration — plugins are then loaded from
 * `<projectDir>/.opensip-tools/<domain>/`. When absent, falls back to
 * the user-level dir (`~/.opensip-tools/<domain>/`).
 */
export async function loadAllPlugins(
  domain: PluginDomain,
  baseDir?: string,
  projectDir?: string,
): Promise<PluginLoadResult> {
  const discovered = discoverPlugins(domain, baseDir, projectDir)

  const plugins: LoadedPlugin[] = []
  const errors: string[] = []

  for (const plugin of discovered) {
    const result = await loadPlugin(plugin, domain)
    plugins.push(result)
    if (result.error) {
      errors.push(`${result.source}: ${result.error}`)
    }
  }

  return {
    plugins,
    totalChecks: plugins.reduce((sum, p) => sum + p.checksRegistered, 0),
    totalRecipes: plugins.reduce((sum, p) => sum + p.recipesRegistered, 0),
    totalAdapters: plugins.reduce((sum, p) => sum + (p.adaptersRegistered ?? 0), 0),
    errors,
  }
}
