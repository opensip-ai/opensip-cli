import { RunScope, runWithScopeSync } from '@opensip-tools/core'
import { initParseCache } from '@opensip-tools/core/languages/parse-cache.js'
import { describe, expect, it } from 'vitest'

import { parsePython } from '../parse.js'
import { getSharedTree } from '../shared-tree.js'

describe('parsePython', () => {
  it('produces a real tree-sitter tree + source', () => {
    const src = 'def f():\n    return 1\n'
    const tree = parsePython(src, 'f.py')
    expect(tree).not.toBeNull()
    expect(tree?.source).toBe(src)
    expect(tree?.tree.rootNode.type).toBe('module')
  })

  it('returns a partial (non-null) tree with hasError for malformed source', () => {
    const tree = parsePython('def (:\n', 'bad.py')
    expect(tree).not.toBeNull()
    expect(tree?.tree.rootNode.hasError).toBe(true)
  })
})

describe('getSharedTree', () => {
  it('returns a tree without an active cache (direct parse)', () => {
    const tree = getSharedTree('x.py', 'x = 1\n')
    expect(tree?.tree.rootNode.type).toBe('module')
  })

  describe('with an active parse cache', () => {
    it('returns the same cached tree identity on repeat calls', () => {
      runWithScopeSync(new RunScope(), () => {
        initParseCache()
        const a = getSharedTree('x.py', 'x = 1\n')
        const b = getSharedTree('x.py', 'x = 1\n')
        expect(a).toBe(b)
      })
    })
  })
})
