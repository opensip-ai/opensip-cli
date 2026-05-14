import { describe, expect, it } from 'vitest'

import { goAdapter } from '../adapter.js'
import { stripComments, stripStrings } from '../strip.js'

describe('goAdapter', () => {
  it('declares the expected identity and extension', () => {
    expect(goAdapter.id).toBe('go')
    expect(goAdapter.fileExtensions).toContain('.go')
  })

  it('parse() returns a tree with line starts', () => {
    const tree = goAdapter.parse('package main\n\nfunc main() {}\n', 'foo.go')
    expect(tree).not.toBeNull()
    expect(tree?.filePath).toBe('foo.go')
    expect(tree?.lineStarts.length).toBe(4)
  })
})

describe('go stripStrings', () => {
  it('replaces regular string content but preserves length', () => {
    const src = 's := "hello world"'
    const out = stripStrings(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('hello')
    expect(out).toContain('s :=')
    expect(out).toContain('"')
  })

  it('strips raw multi-line string body and preserves newlines', () => {
    const src = 's := `\nline1\nline2\n`'
    const out = stripStrings(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('line1')
    expect(out).not.toContain('line2')
    // Newlines must survive so line numbers stay stable
    expect(out.split('\n').length).toBe(src.split('\n').length)
    expect(out).toContain('s :=')
    expect(out).toContain('`')
  })

  it('preserves rune literals (single chars are code, not strings)', () => {
    const src = "c := 'x'"
    const out = stripStrings(src)
    expect(out).toBe(src)
  })

  it('strips entire content of regular string with escape', () => {
    const src = 's := "tab\\there"'
    const out = stripStrings(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('tab')
    expect(out).not.toContain('here')
    expect(out).toContain('s :=')
    expect(out).toContain('"')
  })
})

describe('go stripComments', () => {
  it('replaces line comments', () => {
    const src = 'x := 1 // comment'
    const out = stripComments(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('comment')
    expect(out).toContain('x := 1')
  })

  it('replaces block comments', () => {
    const src = 'x := /* hi */ 2'
    const out = stripComments(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('hi')
    expect(out).toContain('x :=')
    expect(out).toContain('2')
  })

  it('strips string body when // appears inside a string', () => {
    const src = 's := "// not a comment"'
    const out = stripComments(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('not a comment')
    // Outside the string, structure remains intact
    expect(out).toContain('s :=')
    expect(out).toContain('"')
  })

  it('also strips strings', () => {
    const src = '// hi\ns := "secret"'
    const out = stripComments(src)
    expect(out).not.toContain('secret')
    expect(out).not.toContain('hi')
  })
})
