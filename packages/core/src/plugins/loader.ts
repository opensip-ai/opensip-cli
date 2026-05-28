// @fitness-ignore-file performance-anti-patterns -- sequential await across discovered plugin modules preserves load order for deterministic conflict detection; bounded by installed plugin count
/**
 * @fileoverview Generic plugin loader.
 *
 * Owns the machinery that's identical for every plugin domain:
 *
 *   1. Discover plugins for a domain (via discoverPlugins).
 *   2. Dynamic-import each discovered entry point.
 *   3. Hand the imported module to a domain-supplied `registerExports`
 *      callback that performs the actual registration (into the fitness
 *      check registry, the sim scenario registry, the kernel language
 *      registry, etc.).
 *   4. Roll up per-plugin counts into a PluginLoadResult, catching and
 *      reporting per-plugin failures without aborting the whole batch.
 *
 * What we deliberately do NOT own here: the *contents* of registration.
 * Each domain (fit, sim, lang) knows what shape its plugins export and
 * which registry to feed; that lives with the tool that owns the
 * registry. The callback receives a `RegisterCtx` so it can emit
 * structured warnings without re-deriving plugin metadata.
 *
 * This file replaces what used to be a fit-coupled loader in
 * @opensip-tools/fitness. The fitness loader is now a thin adapter
 * that supplies a fit-specific registerExports callback and re-exports
 * loadPlugin / loadAllPlugins with the same public signatures it had
 * before, so existing callers (fit.ts) don't change.
 */

import { pathToFileURL } from 'node:url'

import { logger } from '../lib/logger.js'

import { discoverPlugins } from './discover.js'

import type {
  DiscoveredPlugin,
  LoadedPlugin,
  PluginDomain,
  PluginLoadResult,
} from './types.js'

/** Logger module tag used by every event emitted from the generic loader. */
const MODULE_TAG = 'core:plugins'

/**
 * Per-plugin context handed to a domain's `registerExports` callback.
 * Lets the callback emit structured warnings (with namespace/source
 * already filled in) without re-deriving plugin metadata.
 */
export interface RegisterCtx {
  readonly plugin: DiscoveredPlugin
  /** Emit a structured warning about a malformed plugin export. */
  readonly warn: (evt: string, msg: string, fields?: Record<string, unknown>) => void
  /** Emit a structured debug event. */
  readonly debug: (evt: string, fields?: Record<string, unknown>) => void
}

/** Per-plugin registration counts returned from the callback. */
export interface RegisterCounts {
  readonly checksRegistered?: number
  readonly recipesRegistered?: number
  readonly adaptersRegistered?: number
  readonly scenariosRegistered?: number
}

/**
 * Callback that registers a plugin's exports into the right registries
 * for its domain. Returns the per-counter totals for that plugin.
 * Counters not produced by a domain may be omitted (treated as zero).
 */
export type RegisterExportsFn = (
  mod: Record<string, unknown>,
  ctx: RegisterCtx,
) => Promise<RegisterCounts> | RegisterCounts

/**
 * Load a single discovered plugin: dynamic-import its entry, run the
 * domain's `registerExports` callback, and wrap any thrown error so a
 * single bad plugin doesn't take down the rest of the batch.
 */
export async function loadPlugin(
  plugin: DiscoveredPlugin,
  registerExports: RegisterExportsFn,
): Promise<LoadedPlugin> {
  const ctx: RegisterCtx = {
    plugin,
    warn: (evt, msg, fields) => {
      logger.warn({
        evt,
        module: MODULE_TAG,
        namespace: plugin.namespace,
        source: plugin.source,
        msg,
        ...fields,
      })
    },
    debug: (evt, fields) => {
      logger.debug({
        evt,
        module: MODULE_TAG,
        namespace: plugin.namespace,
        source: plugin.source,
        ...fields,
      })
    },
  }

  try {
    const moduleUrl = pathToFileURL(plugin.entryPoint).href
    const mod = (await import(moduleUrl)) as Record<string, unknown>

    const counts = await registerExports(mod, ctx)

    const checksRegistered = counts.checksRegistered ?? 0
    const recipesRegistered = counts.recipesRegistered ?? 0
    const adaptersRegistered = counts.adaptersRegistered ?? 0
    const scenariosRegistered = counts.scenariosRegistered ?? 0

    const nothingRegistered =
      checksRegistered === 0 &&
      recipesRegistered === 0 &&
      adaptersRegistered === 0 &&
      scenariosRegistered === 0

    if (nothingRegistered) {
      logger.warn({
        evt: 'plugin.loader.no_exports',
        module: MODULE_TAG,
        namespace: plugin.namespace,
        source: plugin.source,
        msg: `Plugin "${plugin.namespace}" registered nothing — nothing to run.`,
      })
    }

    logger.info({
      evt: 'plugin.loader.load.success',
      module: MODULE_TAG,
      namespace: plugin.namespace,
      source: plugin.source,
      checksRegistered,
      recipesRegistered,
      adaptersRegistered,
      scenariosRegistered,
    })

    return {
      namespace: plugin.namespace,
      source: plugin.source,
      type: plugin.type,
      checksRegistered,
      recipesRegistered,
      ...(counts.adaptersRegistered !== undefined && { adaptersRegistered }),
      ...(counts.scenariosRegistered !== undefined && { scenariosRegistered }),
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
      error: errorMsg,
    }
  }
}

/**
 * Discover and load every plugin for a domain. Plugins are loaded
 * sequentially to keep registration order deterministic.
 *
 * Without `projectDir`, no plugins are discovered — there is no
 * user-global fallback, by design.
 */
export async function loadAllPlugins(
  domain: PluginDomain,
  projectDir: string | undefined,
  registerExports: RegisterExportsFn,
): Promise<PluginLoadResult> {
  const discovered = discoverPlugins(domain, projectDir)

  const plugins: LoadedPlugin[] = []
  const errors: string[] = []

  for (const plugin of discovered) {
    const result = await loadPlugin(plugin, registerExports)
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
    totalScenarios: plugins.reduce((sum, p) => sum + (p.scenariosRegistered ?? 0), 0),
    errors,
  }
}
