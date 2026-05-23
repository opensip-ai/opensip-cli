// @fitness-ignore-file toctou-race-condition -- synchronous Map.get/set in single-threaded Node.js runtime; no async gap between read and write
/**
 * @fileoverview Language-aware parse cache.
 *
 * Replaces the TS-hardcoded cache at framework/parse-cache.ts. Keyed by
 * (languageId, filePath, contentFingerprint). Parsing is delegated to the
 * LanguageAdapter resolved from defaultLanguageRegistry.
 *
 * Two access patterns:
 *
 *   1. The exported `initParseCache` / `clearParseCache` /
 *      `getParseTree` helpers operate on a module-level
 *      `defaultParseCache` instance. Production code (FitnessRecipe
 *      service, individual checks) uses these.
 *
 *   2. The exported `LanguageParseCache` class is constructible by
 *      tests (or tools that need an isolated cache). A test that
 *      `new LanguageParseCache(); cache.dispose()` no longer leaves
 *      the previous module-level setTimeout running, so the test
 *      runner's exit cleanliness check passes.
 */

import { logger } from '../lib/logger.js'

import { defaultLanguageRegistry } from './registry.js'

import type { LanguageAdapter } from './adapter.js'

// 10 minutes — the cache is regenerated on every fitness run, so 10
// minutes of staleness is the worst case for a check author who edits
// a source file between runs in a long-lived process. Short enough to
// avoid serving a tree that no longer matches the file on disk; long
// enough that consecutive runs in a watch loop hit the cache.
const AUTO_CLEAR_MS = 10 * 60 * 1000

/**
 * Per-instance parse cache. Each instance owns its own `Map` and
 * (optionally) an auto-clear timer that fires `AUTO_CLEAR_MS` after the
 * cache is started.
 */
export class LanguageParseCache {
  private readonly cache = new Map<string, unknown>()
  private autoClearTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Start the auto-clear timer. Calling this twice resets the timer.
   * Production code goes through `initParseCache()` (which targets the
   * module-level instance); tests call this directly on a fresh
   * instance. The timer is `unref`'d so it doesn't keep the process
   * alive; `dispose()` clears it deterministically.
   */
  startAutoClear(): void {
    if (this.autoClearTimer) clearTimeout(this.autoClearTimer)
    this.autoClearTimer = setTimeout(() => {
      this.cache.clear()
      this.autoClearTimer = null
    }, AUTO_CLEAR_MS)
    this.autoClearTimer.unref()
  }

  getOrParse<TTree>(
    adapter: LanguageAdapter<TTree>,
    filePath: string,
    content: string,
  ): TTree | null {
    // Cache key uses a fast content fingerprint to differentiate between raw
    // content and code-only filtered content. content.length alone is insufficient
    // because filterContent preserves length (replaces chars with same-length spaces).
    // Using the first 64 chars + length provides practical uniqueness.
    const fingerprint = content.slice(0, 64).replaceAll(/\s/g, '') + ':' + content.length
    const key = `${adapter.id}:${filePath}:${fingerprint}`
    const cached = this.cache.get(key) as TTree | undefined
    if (cached !== undefined) return cached

    const tree = adapter.parse(content, filePath)
    if (tree === null) return null
    this.cache.set(key, tree)
    return tree
  }

  clear(): void {
    this.cache.clear()
  }

  /**
   * Clear the cache and any pending auto-clear timer. Tests that
   * construct a fresh `LanguageParseCache()` should call `dispose()`
   * before the test exits so the runner doesn't see a lingering
   * timer handle.
   */
  dispose(): void {
    this.cache.clear()
    if (this.autoClearTimer) {
      clearTimeout(this.autoClearTimer)
      this.autoClearTimer = null
    }
  }

  get size(): number {
    return this.cache.size
  }
}

// =============================================================================
// MODULE-LEVEL DEFAULT INSTANCE + COMPATIBILITY HELPERS
// =============================================================================

let activeCache: LanguageParseCache | null = null

/** Called by FitnessRecipeService.start() before check execution. */
export function initParseCache(): void {
  activeCache?.dispose()
  activeCache = new LanguageParseCache()
  activeCache.startAutoClear()
}

/** Called by FitnessRecipeService after check execution completes. */
export function clearParseCache(): void {
  activeCache?.dispose()
  activeCache = null
}

/**
 * Get or parse the file under the given adapter. Falls back to a direct
 * parse if no cache is active (single-check mode).
 *
 * Generic over TTree so call sites that already know the language (e.g.
 * lang-typescript callers passing the TS adapter) get back ts.SourceFile
 * rather than unknown.
 */
export function getParseTree<TTree>(
  adapter: LanguageAdapter<TTree>,
  filePath: string,
  content: string,
): TTree | null {
  if (activeCache) {
    return activeCache.getOrParse(adapter, filePath, content)
  }
  return adapter.parse(content, filePath)
}

/**
 * Convenience: resolve the adapter for the file via the global registry,
 * then parse. Returns null when no adapter is registered for the extension.
 */
export function getParseTreeForFile(filePath: string, content: string): unknown {
  const adapter = defaultLanguageRegistry.forFile(filePath)
  if (!adapter) {
    logger.debug({
      evt: 'lang.parse.no-adapter',
      module: 'core:languages',
      filePath,
    })
    return null
  }
  return getParseTree(adapter, filePath, content)
}
