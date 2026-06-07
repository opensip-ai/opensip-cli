import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RunScope, runWithScopeSync } from '../../lib/run-scope.js'
import {
  LanguageParseCache,
  clearParseCache,
  getParseTree,
  getParseTreeForFile,
  initParseCache,
} from '../parse-cache.js'
import { LanguageRegistry } from '../registry.js'

import type { LanguageAdapter } from '../adapter.js'

interface FakeTree {
  readonly id: number
  readonly content: string
  readonly filePath: string
}

let nextId = 0

function makeAdapter(id: string, exts: readonly string[]): LanguageAdapter<FakeTree> {
  return {
    id,
    fileExtensions: exts,
    parse: (content, filePath) => ({ id: ++nextId, content, filePath }),
    stripStrings: (s) => s,
    stripComments: (s) => s,
  }
}

describe('language-aware parse cache', () => {
  let testRegistry: LanguageRegistry

  beforeEach(() => {
    nextId = 0
    testRegistry = new LanguageRegistry()
    clearParseCache()
  })

  afterEach(() => {
    clearParseCache()
  })

  it('returns the same tree object on a second call (cache hit)', () => {
    initParseCache()
    const adapter = makeAdapter('rust', ['.rs'])
    const first = getParseTree(adapter, 'foo.rs', 'fn main() {}')
    const second = getParseTree(adapter, 'foo.rs', 'fn main() {}')
    expect(first).not.toBeNull()
    expect(first).toBe(second)
  })

  it('uses different cache entries for different adapters with the same file', () => {
    initParseCache()
    const rustAdapter = makeAdapter('rust', ['.rs'])
    const otherAdapter = makeAdapter('other', ['.other'])
    const rustTree = getParseTree(rustAdapter, 'foo', 'content')
    const otherTree = getParseTree(otherAdapter, 'foo', 'content')
    expect(rustTree).not.toBe(otherTree)
    expect(rustTree?.id).toBe(1)
    expect(otherTree?.id).toBe(2)
  })

  it('different content for the same adapter+file misses', () => {
    initParseCache()
    const adapter = makeAdapter('rust', ['.rs'])
    const a = getParseTree(adapter, 'foo.rs', 'fn a() {}')
    const b = getParseTree(adapter, 'foo.rs', 'fn b() {}')
    expect(a).not.toBe(b)
  })

  it('with no active cache, getParseTree still parses (delegates direct)', () => {
    // No initParseCache call
    const adapter = makeAdapter('rust', ['.rs'])
    const a = getParseTree(adapter, 'foo.rs', 'fn main() {}')
    const b = getParseTree(adapter, 'foo.rs', 'fn main() {}')
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    // No caching → different tree objects
    expect(a).not.toBe(b)
  })

  it('getParseTreeForFile returns null when no adapter claims the extension', () => {
    initParseCache()
    const scope = new RunScope({ languages: testRegistry })
    const result = runWithScopeSync(scope, () => getParseTreeForFile('foo.unknown', 'content'))
    expect(result).toBeNull()
  })

  it('getParseTreeForFile resolves the adapter and parses', () => {
    initParseCache()
    const adapter = makeAdapter('rust', ['.rs'])
    testRegistry.register(adapter)
    const scope = new RunScope({ languages: testRegistry })
    const result = runWithScopeSync(scope, () =>
      getParseTreeForFile('foo.rs', 'fn main() {}'),
    ) as FakeTree | null
    expect(result).not.toBeNull()
    expect(result?.content).toBe('fn main() {}')
  })

  it('getParseTreeForFile throws when called outside runWithScope', () => {
    initParseCache()
    expect(() => getParseTreeForFile('foo.rs', 'fn main() {}')).toThrow(/outside runWithScope/)
  })

  it('clearParseCache zeros the cache', () => {
    initParseCache()
    const adapter = makeAdapter('rust', ['.rs'])
    const first = getParseTree(adapter, 'foo.rs', 'fn main() {}')
    clearParseCache()
    initParseCache()
    const second = getParseTree(adapter, 'foo.rs', 'fn main() {}')
    expect(first).not.toBe(second)
  })

  it('returns null when the adapter parse returns null', () => {
    initParseCache()
    const adapter: LanguageAdapter<FakeTree> = {
      id: 'failing',
      fileExtensions: ['.x'],
      parse: () => null,
      stripStrings: (s) => s,
      stripComments: (s) => s,
    }
    const result = getParseTree(adapter, 'foo.x', 'invalid')
    expect(result).toBeNull()
  })

  describe('LanguageParseCache (fresh instance)', () => {
    it('a fresh instance is isolated from the module-level default cache', () => {
      // Production: module-level default cache via initParseCache().
      initParseCache()
      const adapter = makeAdapter('rust', ['.rs'])
      const fromDefault = getParseTree(adapter, 'foo.rs', 'fn main() {}')
      expect(fromDefault?.id).toBe(1)

      // Fresh instance — its own Map, no cross-contamination.
      const isolated = new LanguageParseCache()
      const fromIsolated = isolated.getOrParse(adapter, 'foo.rs', 'fn main() {}')
      expect(fromIsolated?.id).toBe(2)
      expect(fromIsolated).not.toBe(fromDefault)
      expect(isolated.size).toBe(1)
      isolated.dispose()
    })

    it('clear() empties the parse-tree map without touching the timer', () => {
      const cache = new LanguageParseCache()
      const adapter = makeAdapter('rust', ['.rs'])
      cache.getOrParse(adapter, 'foo.rs', 'fn main() {}')
      expect(cache.size).toBe(1)
      cache.clear()
      expect(cache.size).toBe(0)
      cache.dispose()
    })

    it('the auto-clear timer empties both maps when it fires', () => {
      vi.useFakeTimers()
      try {
        const cache = new LanguageParseCache()
        cache.startAutoClear()
        const adapter = makeAdapter('rust', ['.rs'])
        cache.getOrParse(adapter, 'foo.rs', 'fn main() {}')
        cache.filteredContent.set('raw', 'filtered')
        expect(cache.size).toBe(1)
        expect(cache.filteredContent.size).toBe(1)
        // Advance past AUTO_CLEAR_MS (10 minutes) so the timer fires.
        vi.advanceTimersByTime(10 * 60 * 1000)
        expect(cache.size).toBe(0)
        expect(cache.filteredContent.size).toBe(0)
        cache.dispose()
      } finally {
        vi.useRealTimers()
      }
    })

    it('startAutoClear twice resets the timer rather than stacking two', () => {
      vi.useFakeTimers()
      try {
        const cache = new LanguageParseCache()
        cache.startAutoClear()
        // Second call clears the first timer and installs a fresh one.
        cache.startAutoClear()
        const adapter = makeAdapter('rust', ['.rs'])
        cache.getOrParse(adapter, 'foo.rs', 'fn main() {}')
        vi.advanceTimersByTime(10 * 60 * 1000)
        expect(cache.size).toBe(0)
        cache.dispose()
      } finally {
        vi.useRealTimers()
      }
    })

    it('dispose() clears the auto-clear timer and the cache', () => {
      const cache = new LanguageParseCache()
      cache.startAutoClear()
      const adapter = makeAdapter('rust', ['.rs'])
      cache.getOrParse(adapter, 'foo.rs', 'fn main() {}')
      expect(cache.size).toBe(1)
      cache.dispose()
      expect(cache.size).toBe(0)
      // Calling dispose twice is safe.
      expect(() => cache.dispose()).not.toThrow()
    })
  })

  describe('content fingerprint — raw vs filtered must not collide', () => {
    it('returns distinct trees for same-length raw vs filtered content diverging past char 64', () => {
      // Regression: the cache key once sampled only the first 64 chars (whitespace
      // removed) + length. `filterContent` blanks string/comment regions to
      // same-length spaces, so when the first 64 chars are identical (no stripped
      // content there) and the divergence is a later string literal, raw and
      // filtered content produced the SAME key — an AST check needing raw source
      // got the strings-stripped tree (module specifiers blanked to whitespace),
      // nondeterministically by check order. The full-content fingerprint fixes it.
      const cache = new LanguageParseCache()
      const adapter = makeAdapter('ts', ['.ts'])

      const prefix = '// a sufficiently long identical leading comment to exceed sixty-four chars\n'
      expect(prefix.length).toBeGreaterThan(64)
      const raw = `${prefix}const m = 'REALMODULE';\n`
      const filtered = `${prefix}const m = '          ';\n` // 'REALMODULE' (10) -> 10 spaces
      expect(filtered.length).toBe(raw.length) // same length (filterContent preserves it)

      const rawTree = cache.getOrParse(adapter, 'x.ts', raw)
      const filteredTree = cache.getOrParse(adapter, 'x.ts', filtered)

      // The filtered request must NOT receive the cached raw tree.
      expect(rawTree?.content).toBe(raw)
      expect(filteredTree?.content).toBe(filtered)
      expect(filteredTree?.id).not.toBe(rawTree?.id)

      // Caching still works: re-requesting the raw content hits the same tree.
      expect(cache.getOrParse(adapter, 'x.ts', raw)?.id).toBe(rawTree?.id)
      cache.dispose()
    })
  })
})
