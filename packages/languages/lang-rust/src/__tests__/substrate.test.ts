import { initParseCache, clearParseCache } from '@opensip-tools/core/languages/parse-cache.js'
import { nameOf, walkNodes } from '@opensip-tools/tree-sitter'
import { describe, expect, it } from 'vitest'

import { findEnclosingFunction, getEnclosingFunctionName, isMethod } from '../enclosing.js'
import { parseRust } from '../parse.js'
import {
  isComment,
  isConditional,
  isFunction,
  isImpl,
  isLoop,
  isString,
  isStruct,
} from '../predicates.js'
import { getSharedTree } from '../shared-tree.js'

import type { Node } from '@opensip-tools/tree-sitter'

const SRC = [
  '// c',
  'struct S { x: i32 }',
  'impl S {',
  '    fn m(&self) -> i32 {',
  '        let s = "h";',
  '        if true { return 1; }',
  '        for _i in 0..3 {}',
  '        2',
  '    }',
  '}',
  'fn free() -> i32 { 0 }',
  '',
].join('\n')

function root(): Node {
  const tree = parseRust(SRC, 's.rs')
  if (!tree) throw new Error('no tree')
  return tree.tree.rootNode
}
function count(pred: (n: Node) => boolean): number {
  let n = 0
  walkNodes(root(), (node) => {
    if (pred(node)) n++
  })
  return n
}

describe('rust substrate', () => {
  it('predicates match the tree-sitter-rust node types', () => {
    expect(count(isFunction)).toBe(2)
    expect(count(isStruct)).toBe(1)
    expect(count(isImpl)).toBe(1)
    expect(count(isComment)).toBe(1)
    expect(count(isString)).toBeGreaterThanOrEqual(1)
    expect(count(isConditional)).toBe(1)
    expect(count(isLoop)).toBe(1)
  })

  it('isMethod: a fn in an impl is true, a free fn is false', () => {
    const seen: { name: string | null; method: boolean }[] = []
    walkNodes(root(), (n) => {
      if (isFunction(n)) seen.push({ name: nameOf(n), method: isMethod(n) })
    })
    expect(seen).toContainEqual({ name: 'm', method: true })
    expect(seen).toContainEqual({ name: 'free', method: false })
  })

  it('getSharedTree caches within an active parse cache', () => {
    initParseCache()
    try {
      const a = getSharedTree('x.rs', 'fn x() {}')
      const b = getSharedTree('x.rs', 'fn x() {}')
      expect(a).toBe(b)
    } finally {
      clearParseCache()
    }
  })

  it('findEnclosingFunction resolves the nearest fn', () => {
    const strings: Node[] = []
    walkNodes(root(), (n) => {
      if (n.type === 'string_literal') strings.push(n)
    })
    expect(getEnclosingFunctionName(strings[0])).toBe('m')
    expect(findEnclosingFunction(strings[0])?.type).toBe('function_item')
  })
})
