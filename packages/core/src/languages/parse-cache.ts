// @fitness-ignore-file toctou-race-condition -- synchronous Map.get/set in single-threaded Node.js runtime; no async gap between read and write
/**
 * @fileoverview Language-aware parse cache.
 *
 * Replaces the TS-hardcoded cache at framework/parse-cache.ts. Keyed by
 * (languageId, filePath, contentFingerprint). Parsing is delegated to the
 * LanguageAdapter resolved from defaultLanguageRegistry.
 */

import { logger } from '../lib/logger.js'

import { defaultLanguageRegistry } from './registry.js'

import type { LanguageAdapter } from './adapter.js'

const AUTO_CLEAR_MS = 10 * 60 * 1000 // matches previous behavior

class LanguageParseCache {
  private readonly cache = new Map<string, unknown>()

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

  get size(): number {
    return this.cache.size
  }
}

let activeCache: LanguageParseCache | null = null
let autoClearTimer: ReturnType<typeof setTimeout> | null = null

/** Called by FitnessRecipeService.start() before check execution. */
export function initParseCache(): void {
  activeCache = new LanguageParseCache()
  if (autoClearTimer) clearTimeout(autoClearTimer)
  autoClearTimer = setTimeout(() => {
    if (activeCache) {
      activeCache.clear()
      activeCache = null
    }
  }, AUTO_CLEAR_MS)
  autoClearTimer.unref()
}

/** Called by FitnessRecipeService after check execution completes. */
export function clearParseCache(): void {
  activeCache?.clear()
  activeCache = null
  if (autoClearTimer) {
    clearTimeout(autoClearTimer)
    autoClearTimer = null
  }
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
