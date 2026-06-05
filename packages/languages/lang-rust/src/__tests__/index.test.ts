/**
 * Smoke test for the package barrel.
 *
 * The `src/index.ts` re-exports each public symbol. Importing through the
 * barrel keeps the public surface honest: if a future refactor renames or
 * forgets to re-export one of these, this test fails fast.
 */

import { describe, expect, it } from 'vitest'

import * as pkg from '../index.js'

describe('@opensip-tools/lang-rust barrel', () => {
  it('re-exports the rust adapter and adapters array', () => {
    expect(pkg.rustAdapter).toBeDefined()
    expect(pkg.rustAdapter.id).toBe('rust')
    expect(Array.isArray(pkg.adapters)).toBe(true)
    expect(pkg.adapters).toContain(pkg.rustAdapter)
  })

  it('re-exports parseRust', () => {
    expect(typeof pkg.parseRust).toBe('function')
    const tree = pkg.parseRust('fn main() {}', 'main.rs')
    expect(tree?.tree.rootNode.type).toBe('source_file')
  })

  it('re-exports stripStrings and stripComments', () => {
    expect(typeof pkg.stripStrings).toBe('function')
    expect(typeof pkg.stripComments).toBe('function')
  })
})
