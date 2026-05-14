import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { LanguageAdapter } from '../adapter.js'
import {
  clearParseCache,
  getParseTree,
  getParseTreeForFile,
  initParseCache,
} from '../parse-cache.js'
import { defaultLanguageRegistry } from '../registry.js'

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
  beforeEach(() => {
    nextId = 0
    defaultLanguageRegistry.clear()
    clearParseCache()
  })

  afterEach(() => {
    defaultLanguageRegistry.clear()
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
    const result = getParseTreeForFile('foo.unknown', 'content')
    expect(result).toBeNull()
  })

  it('getParseTreeForFile resolves the adapter and parses', () => {
    initParseCache()
    const adapter = makeAdapter('rust', ['.rs'])
    defaultLanguageRegistry.register(adapter)
    const result = getParseTreeForFile('foo.rs', 'fn main() {}') as FakeTree | null
    expect(result).not.toBeNull()
    expect(result?.content).toBe('fn main() {}')
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
})
