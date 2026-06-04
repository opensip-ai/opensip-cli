/**
 * @fileoverview Plugin contract types for opensip-tools
 *
 * Plugins can be npm packages or loose JS/MJS files.
 *
 * Tool-specific plugin export shapes (e.g. fitness's `FitPluginExports`,
 * which references Check / FitnessRecipe types) live with the tool that
 * owns them. This file holds the kernel-level types that any tool
 * loader can use without dragging in tool-specific symbols.
 */

import type { LanguageAdapter } from '../languages/adapter.js'

// =============================================================================
// PLUGIN EXPORTS CONTRACT
// =============================================================================

/** What a language plugin package/file exports */
export interface LangPluginExports {
  readonly adapters?: readonly LanguageAdapter[]
}

/**
 * Union of all plugin export shapes — kept open so tool-specific exports
 * (e.g. fitness's FitPluginExports) can be assigned through structural
 * compatibility. Each tool owns its own export-shape interface.
 */
export type PluginExports = LangPluginExports | Record<string, unknown>

// =============================================================================
// DISCOVERY TYPES
// =============================================================================

/** Discovered plugin before loading */
export interface DiscoveredPlugin {
  readonly type: 'package' | 'file'
  /** Absolute path to the entry point */
  readonly entryPoint: string
  /** Namespace derived from package name or filename */
  readonly namespace: string
  /** Package name (for npm packages) or filename (for loose files) */
  readonly source: string
}

// =============================================================================
// LOADING TYPES
// =============================================================================

/** Result of loading a single plugin */
export interface LoadedPlugin {
  readonly namespace: string
  readonly source: string
  readonly type: 'package' | 'file'
  readonly checksRegistered: number
  readonly recipesRegistered: number
  /** Number of language adapters registered (only for 'lang' domain). */
  readonly adaptersRegistered?: number
  /** Number of scenarios registered (only for 'sim' domain). */
  readonly scenariosRegistered?: number
  readonly error?: string
}

/** Result of loading all plugins for a domain */
export interface PluginLoadResult {
  readonly plugins: readonly LoadedPlugin[]
  readonly totalChecks: number
  readonly totalRecipes: number
  readonly totalAdapters: number
  readonly totalScenarios: number
  readonly errors: readonly string[]
}

/** Plugin domains. `lang` packs register language adapters; the others register checks/recipes. */
export type PluginDomain = 'fit' | 'sim' | 'lang'
