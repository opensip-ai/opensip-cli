/**
 * @fileoverview Plugin loader — dynamic import and registration
 *
 * Takes discovered plugins, imports them, validates their exports,
 * and registers checks/recipes with namespaces.
 */

import { pathToFileURL } from 'node:url'

import { logger, defaultLanguageRegistry, discoverPlugins } from '@opensip-tools/core'


import { isCheck } from '../framework/check-types.js'
import { defaultRegistry } from '../framework/registry.js'
import { defaultRecipeRegistry } from '../recipes/registry.js'

import type { FitPluginExports } from './types.js'
import type { FitnessRecipe } from '../recipes/types.js'
import type {
  DiscoveredPlugin,
  LangPluginExports,
  LoadedPlugin,
  PluginDomain,
  PluginLoadResult,
} from '@opensip-tools/core'

/** Logger module tag used by every event emitted from this loader. */
const MODULE_TAG = 'core:plugins'

/**
 * Load a single discovered plugin.
 *
 * For `domain === 'lang'`, the module is expected to export an `adapters`
 * array of LanguageAdapter; each is registered with defaultLanguageRegistry.
 * For other domains, registers checks and recipes with defaultRegistry and
 * defaultRecipeRegistry respectively.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- plugin loader dispatcher: handles three domains and lifecycle (validate, register, error-wrap) inline; splitting fragments error context
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

    // Lang domain: register language adapters from `adapters` array,
    // named exports, and default export. Adapters are deduplicated by id.
    if (domain === 'lang') {
      const registeredAdapterIds = new Set<string>()

      const tryRegisterAdapter = (value: unknown, sourceLabel: string): void => {
        if (!looksLikeLanguageAdapter(value)) return
        const id = (value as { id: string }).id
        if (registeredAdapterIds.has(id)) return
        defaultLanguageRegistry.register(value as Parameters<typeof defaultLanguageRegistry.register>[0])
        registeredAdapterIds.add(id)
        adaptersRegistered++
        logger.debug({
          evt: 'plugin.loader.adapter.registered',
          module: MODULE_TAG,
          namespace: plugin.namespace,
          source: sourceLabel,
          id,
        })
      }

      if (mod.adapters !== undefined) {
        if (Array.isArray(mod.adapters)) {
          for (const [index, adapter] of mod.adapters.entries()) {
            if (looksLikeLanguageAdapter(adapter)) {
              tryRegisterAdapter(adapter, `adapters[${index}]`)
            } else {
              logger.warn({
                evt: 'plugin.loader.invalid_adapter_item',
                module: MODULE_TAG,
                namespace: plugin.namespace,
                source: plugin.source,
                index,
                msg: `Plugin "${plugin.namespace}" adapters[${index}] is not a valid LanguageAdapter — skipping.`,
              })
            }
          }
        } else {
          logger.warn({
            evt: 'plugin.loader.invalid_adapters_export',
            module: MODULE_TAG,
            namespace: plugin.namespace,
            source: plugin.source,
            msg: `Plugin "${plugin.namespace}" exports "adapters" but it is not an array — skipping adapter registration.`,
          })
        }
      }

      // Named exports that look like LanguageAdapter
      for (const [exportName, value] of Object.entries(mod)) {
        if (
          exportName === 'default' ||
          exportName === 'adapters' ||
          exportName === 'checks' ||
          exportName === 'recipes' ||
          exportName === 'metadata'
        ) continue
        tryRegisterAdapter(value, `named:${exportName}`)
      }

      // Default export: a single LanguageAdapter
      const defaultExport = (mod as { default?: unknown }).default
      tryRegisterAdapter(defaultExport, 'default')
    }

    // Register checks with namespace (skipped for lang domain).
    //
    // Two authorship styles are supported:
    //   1. `export const checks = [...]`  — array of Check instances
    //   2. `export const myCheck = defineCheck({...})` — Check as a named export
    //
    // Style 2 enables single-file plugins that drop into ~/.opensip-tools/fit/
    // to author one check per file without a redundant array wrapper.
    // Both styles can coexist in the same module; checks are deduplicated by
    // their stable id so a check appearing in both an array and a named
    // export is registered exactly once.
    if (domain !== 'lang') {
      const registeredIds = new Set<string>()

      // Style 1: explicit `checks` array
      if (mod.checks !== undefined) {
        if (Array.isArray(mod.checks)) {
          for (const [index, check] of mod.checks.entries()) {
            if (isCheck(check)) {
              if (!registeredIds.has(check.config.id)) {
                defaultRegistry.register(check, plugin.namespace)
                registeredIds.add(check.config.id)
                checksRegistered++
              }
            } else {
              logger.warn({
                evt: 'plugin.loader.invalid_check_item',
                module: MODULE_TAG,
                namespace: plugin.namespace,
                source: plugin.source,
                index,
                msg: `Plugin "${plugin.namespace}" checks[${index}] is not a valid Check object — skipping.`,
              })
            }
          }
        } else {
          logger.warn({
            evt: 'plugin.loader.invalid_checks_export',
            module: MODULE_TAG,
            namespace: plugin.namespace,
            source: plugin.source,
            msg: `Plugin "${plugin.namespace}" exports "checks" but it is not an array — skipping checks registration.`,
          })
        }
      }

      // Style 2: any named export that is a Check instance
      for (const [exportName, value] of Object.entries(mod)) {
        if (exportName === 'default' || exportName === 'checks' || exportName === 'recipes' || exportName === 'metadata') continue
        if (isCheck(value) && !registeredIds.has(value.config.id)) {
            defaultRegistry.register(value, plugin.namespace)
            registeredIds.add(value.config.id)
            checksRegistered++
          }
      }

      // Default export: a single Check instance
      const defaultExport = (mod as { default?: unknown }).default
      if (isCheck(defaultExport) && !registeredIds.has(defaultExport.config.id)) {
          defaultRegistry.register(defaultExport, plugin.namespace)
          registeredIds.add(defaultExport.config.id)
          checksRegistered++
        }
    }

    // Register recipes (skipped for lang domain)
    if (domain !== 'lang' && mod.recipes !== undefined) {
      const recipes: readonly FitnessRecipe[] = mod.recipes
      for (const [index, recipe] of recipes.entries()) {
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
            module: MODULE_TAG,
            namespace: plugin.namespace,
            source: plugin.source,
            index,
            msg: `Plugin "${plugin.namespace}" recipes[${index}] is not a valid Recipe object (missing id or name) — skipping.`,
          })
        }
      }
    }

    // Warn only when nothing was registered. With named-export discovery,
    // counting actual registrations is more accurate than checking which
    // declared exports were present.
    const nothingRegistered =
      domain === 'lang'
        ? adaptersRegistered === 0
        : checksRegistered === 0 && recipesRegistered === 0

    if (nothingRegistered) {
      logger.warn({
        evt: 'plugin.loader.no_exports',
        module: MODULE_TAG,
        namespace: plugin.namespace,
        source: plugin.source,
        domain,
        msg:
          domain === 'lang'
            ? `Plugin "${plugin.namespace}" registered no language adapters — nothing to use.`
            : `Plugin "${plugin.namespace}" registered no checks or recipes — nothing to run.`,
      })
    }

    logger.info({
      evt: 'plugin.loader.load.success',
      module: MODULE_TAG,
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
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)

    logger.warn({
      evt: 'plugin.loader.load.error',
      module: MODULE_TAG,
      namespace: plugin.namespace,
      source: plugin.source,
      error: errorMsg,
      err: error instanceof Error ? error : undefined,
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
 * Structural check for LanguageAdapter — used by the lang plugin domain
 * to identify adapter values among arbitrary named exports. We don't
 * have a runtime type guard equivalent to isCheck() for adapters, so
 * we duck-type the required surface (`id`, `fileExtensions`, `parse`,
 * `stripStrings`, `stripComments`).
 */
function looksLikeLanguageAdapter(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    Array.isArray(v.fileExtensions) &&
    typeof v.parse === 'function' &&
    typeof v.stripStrings === 'function' &&
    typeof v.stripComments === 'function'
  )
}

/**
 * Discover and load all plugins for a domain. Loads sequentially to
 * ensure deterministic registration order.
 *
 * v3 layout: discovers loose `.mjs` files under
 * `<projectDir>/opensip-tools/<tool>/{checks,recipes,scenarios}/` plus
 * any npm-installed packages in
 * `<projectDir>/opensip-tools/.runtime/plugins/<domain>/node_modules/`
 * that are listed in `plugins.<domain>` in the project config.
 *
 * Without a `projectDir`, no plugins are loaded — there's no
 * user-global fallback in v3.
 */
export async function loadAllPlugins(
  domain: PluginDomain,
  projectDir?: string,
): Promise<PluginLoadResult> {
  const discovered = discoverPlugins(domain, projectDir)

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
