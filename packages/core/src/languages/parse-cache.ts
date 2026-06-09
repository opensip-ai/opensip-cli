/**
 * @fileoverview Language-aware parse cache — scope-owned helpers.
 *
 * The `LanguageParseCache` class definition lives in `parse-cache-class.ts`
 * so `RunScope` (which holds a `LanguageParseCache` field) and this module
 * (which reads `currentScope()`) don't form an import cycle.
 *
 * The `initParseCache` / `clearParseCache` / `getParseTree` helpers operate on
 * the CURRENT RunScope's `parseCache` (`currentScope().parseCache`), NOT a
 * module-level singleton. This is the scope-isolation fix (audit F2): two
 * concurrent fit runs (different scopes) carry independent parse caches, and no
 * process-global cache leaks state between runs or survives a run's teardown.
 * Outside a `RunScope`, `initParseCache`/`clearParseCache` are no-ops and
 * `getParseTree` falls back to a direct, uncached parse (single-check mode).
 *
 * The `LanguageParseCache` class is still exported for `RunScope` (which
 * constructs the per-run instance) and for tests/tools that want an isolated
 * cache.
 */

import { logger } from '../lib/logger.js'
import { currentScope } from '../lib/run-scope.js'

import type { LanguageAdapter } from './adapter.js'

export { LanguageParseCache } from './parse-cache-class.js'

// =============================================================================
// SCOPE-OWNED PARSE-CACHE HELPERS
// =============================================================================

/**
 * Called by FitnessRecipeService before check execution. Clears any stale
 * entries on the current scope's parse cache and arms its auto-clear timer.
 * No-op outside a RunScope.
 */
export function initParseCache(): void {
  const cache = currentScope()?.parseCache
  if (!cache) return
  cache.clear()
  cache.startAutoClear()
}

/**
 * Called by FitnessRecipeService after check execution completes. Clears the
 * current scope's parse cache and stops its auto-clear timer. No-op outside a
 * RunScope — the scope itself disposes its cache on teardown.
 */
export function clearParseCache(): void {
  currentScope()?.parseCache.dispose()
}

/**
 * Get or parse the file under the given adapter, using the CURRENT scope's
 * parse cache. Falls back to a direct (uncached) parse when there is no active
 * scope (single-check mode).
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
  const cache = currentScope()?.parseCache
  if (cache) {
    return cache.getOrParse(adapter, filePath, content)
  }
  return adapter.parse(content, filePath)
}

/**
 * Convenience: resolve the adapter for the file via the current scope's
 * language registry, then parse. Returns null when no adapter is
 * registered for the extension. Throws when called outside runWithScope —
 * engine work must run inside a RunScope so adapters resolve via
 * cli.scope.languages.
 *
 * @throws {Error} When called outside a `runWithScope(...)` block (no current scope).
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
