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

import type { LanguageAdapter } from '../languages/adapter.js';

// =============================================================================
// PLUGIN EXPORTS CONTRACT
// =============================================================================

/** What a language plugin package/file exports */
export interface LangPluginExports {
  readonly adapters?: readonly LanguageAdapter[];
}

/**
 * Union of all plugin export shapes — kept open so tool-specific exports
 * (e.g. fitness's FitPluginExports) can be assigned through structural
 * compatibility. Each tool owns its own export-shape interface.
 */
export type PluginExports = LangPluginExports | Record<string, unknown>;

// =============================================================================
// DISCOVERY TYPES
// =============================================================================

/**
 * Where a tool's project-local plugins live. Supplied by the tool (via
 * its `Tool.pluginLayout` descriptor) and threaded into `discoverPlugins`
 * / `loadAllPlugins`. The kernel never enumerates tool domains itself —
 * this descriptor is the seam that keeps core tool-agnostic
 * (ADR-0009 corollary 1 / M2).
 */
export interface PluginLayout {
  /**
   * Path/domain segment. User loose-file plugins live under
   * `<project>/opensip-tools/<domain>/<kind>/` and npm plugins under
   * `<project>/opensip-tools/.runtime/plugins/<domain>/`. Also the key
   * read from `opensip-tools.config.yml#plugins.<domain>`.
   */
  readonly domain: string;
  /**
   * User-source subdirectories walked for loose `.mjs`/`.js` plugins —
   * e.g. `['checks', 'recipes']` for fitness, `['scenarios', 'recipes']`
   * for simulation. Empty means no loose-file layout (npm plugins only).
   */
  readonly userSubdirs: readonly string[];
}

/** Discovered plugin before loading */
export interface DiscoveredPlugin {
  readonly type: 'package' | 'file';
  /** Absolute path to the entry point */
  readonly entryPoint: string;
  /** Namespace derived from package name or filename */
  readonly namespace: string;
  /** Package name (for npm packages) or filename (for loose files) */
  readonly source: string;
}

// =============================================================================
// LOADING TYPES
// =============================================================================

/**
 * Result of loading a single plugin. `registered` is a generic count
 * map keyed by whatever artifact kinds the tool's `registerExports`
 * callback reports (e.g. `{ checks: 3, recipes: 1 }`, `{ scenarios: 2 }`,
 * `{ adapters: 1 }`). The kernel carries no tool-specific counter names
 * (ADR-0009 M2) — it only sums the map.
 */
export interface LoadedPlugin {
  readonly namespace: string;
  readonly source: string;
  readonly type: 'package' | 'file';
  /** Per-kind registration counts reported by the domain callback. */
  readonly registered: Readonly<Record<string, number>>;
  readonly error?: string;
}

/**
 * Result of loading all plugins for a layout. `totals` is the
 * per-kind sum across every loaded plugin's `registered` map.
 */
export interface PluginLoadResult {
  readonly plugins: readonly LoadedPlugin[];
  readonly totals: Readonly<Record<string, number>>;
  readonly errors: readonly string[];
}

// Note: there is deliberately NO `PluginDomain` type. A plugin domain is a
// plain `string` segment (see `PluginLayout.domain`); the kernel does not
// enumerate — nor even name — the first-party domains (ADR-0009 corollary 1).
