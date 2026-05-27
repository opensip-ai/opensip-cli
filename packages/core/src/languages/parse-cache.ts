/**
 * @fileoverview Language-aware parse cache — module-level helpers.
 *
 * The `LanguageParseCache` class definition lives in `parse-cache-class.ts`
 * so `RunScope` (which holds a default `LanguageParseCache` field) and
 * this module (which reads `currentScope()`) don't form an import cycle.
 * The helpers in this file operate on a module-level default instance.
 *
 * Two access patterns:
 *
 *   1. The exported `initParseCache` / `clearParseCache` / `getParseTree`
 *      helpers operate on a module-level `defaultParseCache` instance.
 *      Production code (FitnessRecipe service, individual checks) uses
 *      these.
 *
 *   2. The exported `LanguageParseCache` class is constructible by tests
 *      (or tools that need an isolated cache). A test that
 *      `new LanguageParseCache(); cache.dispose()` no longer leaves the
 *      module-level setTimeout running, so the test runner's exit
 *      cleanliness check passes.
 */

import { logger } from '../lib/logger.js'
import { currentScope } from '../lib/run-scope.js'

import { LanguageParseCache } from './parse-cache-class.js'

import type { LanguageAdapter } from './adapter.js'

export { LanguageParseCache } from './parse-cache-class.js'

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
 * Convenience: resolve the adapter for the file via the current scope's
 * language registry, then parse. Returns null when no adapter is
 * registered for the extension. Throws when called outside runWithScope —
 * engine work must run inside a RunScope so adapters resolve via
 * cli.scope.languages.
 */
export function getParseTreeForFile(filePath: string, content: string): unknown {
  const scope = currentScope()
  if (!scope) {
    throw new Error(
      'getParseTreeForFile() called outside runWithScope. ' +
        'Engine work must run inside a RunScope so language adapters resolve via cli.scope.languages.',
    )
  }
  const adapter = scope.languages.forFile(filePath)
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
