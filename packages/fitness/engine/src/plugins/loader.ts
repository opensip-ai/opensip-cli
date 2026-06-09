/**
 * @fileoverview Fitness plugin loader — adapter over core's generic loader.
 *
 * Core owns the discovery, dynamic-import, error-wrap, and log machinery
 * (see @opensip-tools/core's loadPlugin / loadAllPlugins). This file
 * supplies the fitness-specific `registerExports` callback that knows
 * how to interpret a `FitPluginExports`-shaped module: register
 * language adapters (for the `lang` domain), checks (named or in a
 * `checks` array), and recipes.
 *
 * Public API (`loadPlugin`, `loadAllPlugins`) is preserved so existing
 * callers (fit.ts) don't change.
 */

import {
  currentScope,
  loadAllPlugins as coreLoadAllPlugins,
  loadPlugin as coreLoadPlugin,
  registerRecipesFromMod,
} from '@opensip-tools/core'

import { isCheck } from '../framework/check-types.js'
import { currentCheckRegistry, currentRecipeRegistry } from '../framework/scope-registry.js'

import type { FitPluginExports } from './types.js'
import type {
  DiscoveredPlugin,
  LangPluginExports,
  LoadedPlugin,
  PluginLayout,
  PluginLoadResult,
  RegisteredCounts,
  RegisterCtx,
} from '@opensip-tools/core'

/**
 * Fitness's project-local plugin layout — user checks/recipes live under
 * `<project>/opensip-tools/fit/{checks,recipes}/`. Exported so the
 * `fitnessTool` descriptor (`Tool.pluginLayout`) and the CLI's `plugin`
 * command share one source of truth (ADR-0009 corollary 1).
 */
export const FIT_PLUGIN_LAYOUT: PluginLayout = {
  domain: 'fit',
  userSubdirs: ['checks', 'recipes'],
}

/**
 * Language-adapter domain layout — adapters ship as direct CLI deps, so
 * there is no project-local loose-file layout. Discovery yields nothing
 * unless `plugins.lang` is declared.
 */
const LANG_PLUGIN_LAYOUT: PluginLayout = { domain: 'lang', userSubdirs: [] }

/**
 * Register a fitness-domain plugin's exports. Supports two authorship
 * styles for checks:
 *
 *   1. `export const checks = [...]`           — array of Check instances
 *   2. `export const myCheck = defineCheck(...)` — Check as a named export
 *
 * Both styles can coexist in the same module; checks are deduplicated
 * by their stable id so a check appearing in both forms is registered
 * exactly once. Recipes are registered from a `recipes` array.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- fit plugin registrar: two authorship styles for checks + recipe registration + default-export fallback; splitting fragments the warn/skip control flow
function registerFitExports(
  mod: Record<string, unknown>,
  ctx: RegisterCtx,
): RegisteredCounts {
  const fit = mod as FitPluginExports
  const checkRegistry = currentCheckRegistry()
  const registeredIds = new Set<string>()
  let checksRegistered = 0
  let recipesRegistered = 0

  // Style 1: explicit `checks` array
  if (fit.checks !== undefined) {
    if (Array.isArray(fit.checks)) {
      for (const [index, check] of fit.checks.entries()) {
        if (isCheck(check)) {
          if (!registeredIds.has(check.config.id)) {
            checkRegistry.register(check, ctx.plugin.namespace)
            registeredIds.add(check.config.id)
            checksRegistered++
          }
        } else {
          ctx.warn(
            'plugin.loader.invalid_check_item',
            `Plugin "${ctx.plugin.namespace}" checks[${index}] is not a valid Check object — skipping.`,
            { index },
          )
        }
      }
    } else {
      ctx.warn(
        'plugin.loader.invalid_checks_export',
        `Plugin "${ctx.plugin.namespace}" exports "checks" but it is not an array — skipping checks registration.`,
      )
    }
  }

  // Style 2: any named export that is a Check instance
  for (const [exportName, value] of Object.entries(mod)) {
    if (
      exportName === 'default' ||
      exportName === 'checks' ||
      exportName === 'recipes' ||
      exportName === 'metadata'
    ) continue
    if (isCheck(value) && !registeredIds.has(value.config.id)) {
      checkRegistry.register(value, ctx.plugin.namespace)
      registeredIds.add(value.config.id)
      checksRegistered++
    }
  }

  // Default export: a single Check instance
  const defaultExport = mod.default
  if (isCheck(defaultExport) && !registeredIds.has(defaultExport.config.id)) {
    checkRegistry.register(defaultExport, ctx.plugin.namespace)
    registeredIds.add(defaultExport.config.id)
    checksRegistered++
  }

  // Recipes — delegate to the shared helper. ctx.warn adapts to the
  // helper's onWarn channel; the helper uses registry.has() to skip
  // duplicates rather than the dead try/catch this block used to wrap.
  const { recipesRegistered: helperRecipesRegistered } = registerRecipesFromMod(
    fit,
    currentRecipeRegistry(),
    {
      namespace: ctx.plugin.namespace,
      onWarn: (evt, message, extra) => ctx.warn(evt, message, extra),
    },
  )
  recipesRegistered += helperRecipesRegistered

  return { checks: checksRegistered, recipes: recipesRegistered }
}

/**
 * Register a lang-domain plugin's exports. Pulls LanguageAdapter
 * instances from `adapters` array, named exports, and the default
 * export; deduplicates by adapter id.
 */
function registerLangExports(
  mod: Record<string, unknown>,
  ctx: RegisterCtx,
): RegisteredCounts {
  const lang = mod as LangPluginExports
  const registeredAdapterIds = new Set<string>()
  let adaptersRegistered = 0

  // The throws-documentation check requires JSDoc on functions with `throw`
  // statements, but JSDoc placed above a `const arrow = ...` assignment is
  // not attached to the arrow node (TS's leading-comment scan starts at the
  // arrow's getFullStart, which is past the `=`). The closure captures
  // `registeredAdapterIds` / `adaptersRegistered` / `ctx`, so it can't be
  // hoisted to a top-level `function` declaration. Suppress the next-line
  // directive with the same contract the JSDoc would carry.
  // @fitness-ignore-next-line throws-documentation -- closure throws Error when called outside runWithScope; JSDoc cannot attach to a const-arrow
  const tryRegisterAdapter = (value: unknown, sourceLabel: string): void => {
    if (!looksLikeLanguageAdapter(value)) return
    const id = (value as { id: string }).id
    if (registeredAdapterIds.has(id)) return
    const scope = currentScope()
    if (!scope) {
      throw new Error(
        'fitness plugin loader: language adapter registration attempted outside runWithScope. ' +
          'Plugin loading must run inside a RunScope so adapters land in cli.scope.languages.',
      )
    }
    scope.languages.register(value as Parameters<typeof scope.languages.register>[0])
    registeredAdapterIds.add(id)
    adaptersRegistered++
    ctx.debug('plugin.loader.adapter.registered', { source: sourceLabel, id })
  }

  if (lang.adapters !== undefined) {
    if (Array.isArray(lang.adapters)) {
      for (const [index, adapter] of lang.adapters.entries()) {
        if (looksLikeLanguageAdapter(adapter)) {
          tryRegisterAdapter(adapter, `adapters[${index}]`)
        } else {
          ctx.warn(
            'plugin.loader.invalid_adapter_item',
            `Plugin "${ctx.plugin.namespace}" adapters[${index}] is not a valid LanguageAdapter — skipping.`,
            { index },
          )
        }
      }
    } else {
      ctx.warn(
        'plugin.loader.invalid_adapters_export',
        `Plugin "${ctx.plugin.namespace}" exports "adapters" but it is not an array — skipping adapter registration.`,
      )
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
  tryRegisterAdapter(mod.default, 'default')

  return { adapters: adaptersRegistered }
}

/**
 * Fitness-domain `loadPlugin` entry point. Dispatches to the right
 * `registerExports` callback (fit vs lang) and delegates to core's loader.
 */
export async function loadPlugin(
  plugin: DiscoveredPlugin,
  domain = 'fit',
): Promise<LoadedPlugin> {
  const register = domain === 'lang' ? registerLangExports : registerFitExports
  return coreLoadPlugin(plugin, register)
}

/**
 * Fitness-domain `loadAllPlugins` entry point. Dispatches to the right
 * `registerExports` callback (fit vs lang) and delegates to core's loader.
 */
export async function loadAllPlugins(
  domain: string,
  projectDir?: string,
): Promise<PluginLoadResult> {
  const register = domain === 'lang' ? registerLangExports : registerFitExports
  const layout = domain === 'lang' ? LANG_PLUGIN_LAYOUT : FIT_PLUGIN_LAYOUT
  return coreLoadAllPlugins(layout, projectDir, register)
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
