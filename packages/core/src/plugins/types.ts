/**
 * @fileoverview Plugin contract types for opensip-tools
 *
 * Plugins can be npm packages or loose JS/MJS files.
 * Both export the same shape: arrays of checks and/or recipes.
 */

import type { Check } from '../framework/check-types.js'
import type { LanguageAdapter } from '../languages/adapter.js'
import type { FitnessRecipe } from '../recipes/types.js'

// =============================================================================
// PLUGIN EXPORTS CONTRACT
// =============================================================================

/**
 * Display entry for a fitness check: [icon, displayName].
 *
 * Check packages can contribute display metadata for their own checks by
 * exporting a `checkDisplay` map. The CLI merges these from every loaded
 * package; later registrations win on key collision (last package loaded
 * has final say). Slugs without an entry fall back to kebab-to-title-case.
 */
export type CheckDisplayEntry = readonly [icon: string, displayName: string]

/** What a fitness plugin package/file exports */
export interface FitPluginExports {
  readonly checks?: readonly Check[]
  readonly recipes?: readonly FitnessRecipe[]
  readonly metadata?: PluginMetadata
  /**
   * Optional display map: check slug → [icon, displayName].
   * The CLI merges these from every loaded check package and uses
   * the merged map when rendering tables and dashboard catalog entries.
   */
  readonly checkDisplay?: Readonly<Record<string, CheckDisplayEntry>>
}

/** What a language plugin package/file exports */
export interface LangPluginExports {
  readonly adapters?: readonly LanguageAdapter[]
  readonly metadata?: PluginMetadata
}

/** Union of all plugin export shapes. */
export type PluginExports = FitPluginExports | LangPluginExports

/** Optional plugin metadata */
export interface PluginMetadata {
  readonly name: string
  readonly version?: string
  readonly author?: string
  readonly description?: string
  readonly homepage?: string
}

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
  readonly error?: string
}

/** Result of loading all plugins for a domain */
export interface PluginLoadResult {
  readonly plugins: readonly LoadedPlugin[]
  readonly totalChecks: number
  readonly totalRecipes: number
  readonly totalAdapters: number
  readonly errors: readonly string[]
}

/** Plugin domains. `lang` packs register language adapters; the others register checks/recipes. */
export type PluginDomain = 'fit' | 'sim' | 'asm' | 'lang'
