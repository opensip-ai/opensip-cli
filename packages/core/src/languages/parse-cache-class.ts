// @fitness-ignore-file toctou-race-condition -- synchronous Map.get/set in single-threaded Node.js runtime; no async gap between read and write
/**
 * @fileoverview `LanguageParseCache` class definition.
 *
 * Lives in its own module so `RunScope` (which holds a default
 * `LanguageParseCache` instance) and the module-level helpers in
 * `parse-cache.ts` (which read `currentScope()`) don't form an
 * import cycle. The class has zero deps on `run-scope.ts`; the helpers
 * import the class from here, and `run-scope.ts` also imports the
 * class from here.
 */

import type { LanguageAdapter } from './adapter.js'

// 10 minutes — the cache is regenerated on every fitness run, so 10
// minutes of staleness is the worst case for a check author who edits
// a source file between runs in a long-lived process. Short enough to
// avoid serving a tree that no longer matches the file on disk; long
// enough that consecutive runs in a watch loop hit the cache.
const AUTO_CLEAR_MS = 10 * 60 * 1000

/**
 * Per-instance parse cache. Each instance owns its own parse-tree
 * `Map`, a sibling `filteredContent` `Map` (for language-specific
 * filtered-content caching keyed by raw content), and (optionally) an
 * auto-clear timer that fires `AUTO_CLEAR_MS` after the cache is
 * started.
 *
 * The two maps live together because they share the same lifecycle —
 * a fresh run starts both at empty, a `dispose()` clears both, and the
 * auto-clear timer drops both. The maps use different keys (parse-tree
 * map is keyed by adapter+filePath+fingerprint; filtered-content map
 * is keyed by raw content) because the two upstream call paths use
 * different identities.
 */
export class LanguageParseCache {
  private readonly cache = new Map<string, unknown>()
  /**
   * Language-specific filtered-content cache. Keyed by raw content
   * string (no adapter or file path prefix) because the
   * `filterContent(content)` API in `@opensip-tools/lang-typescript`
   * is content-only. Phase 6 Task 6.4 moved this off a separate
   * module-level Map; the merge is by lifecycle, not by key shape.
   */
  readonly filteredContent = new Map<string, unknown>()
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
      this.filteredContent.clear()
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
    this.filteredContent.clear()
  }

  /**
   * Clear the cache and any pending auto-clear timer. Tests that
   * construct a fresh `LanguageParseCache()` should call `dispose()`
   * before the test exits so the runner doesn't see a lingering
   * timer handle.
   */
  dispose(): void {
    this.cache.clear()
    this.filteredContent.clear()
    if (this.autoClearTimer) {
      clearTimeout(this.autoClearTimer)
      this.autoClearTimer = null
    }
  }

  get size(): number {
    return this.cache.size
  }
}
