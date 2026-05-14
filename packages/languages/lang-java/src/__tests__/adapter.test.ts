import { describe, expect, it } from 'vitest'

import { javaAdapter } from '../adapter.js'
import { stripComments, stripStrings } from '../strip.js'

describe('javaAdapter', () => {
  it('declares the expected identity and extension', () => {
    expect(javaAdapter.id).toBe('java')
    expect(javaAdapter.fileExtensions).toContain('.java')
  })

  it('parse() returns a tree with line starts', () => {
    const tree = javaAdapter.parse(
      'class A {\n  void m() {}\n}',
      'A.java',
    )
    expect(tree).not.toBeNull()
    expect(tree?.filePath).toBe('A.java')
    expect(tree?.lineStarts.length).toBe(3)
  })
})

describe('java stripStrings', () => {
  it('replaces regular string content but preserves length', () => {
    const src = 'String s = "hello world";'
    const out = stripStrings(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('hello')
    expect(out).toContain('String s =')
    expect(out).toContain('"')
  })

  it('strips text block body but preserves the triple quotes and newlines', () => {
    const src = 'String s = """\nfoo bar\n""";'
    const out = stripStrings(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('foo')
    expect(out).not.toContain('bar')
    // Triple quotes (delimiters) survive
    expect(out).toContain('"""')
    // Newlines are preserved
    expect(out.split('\n').length).toBe(src.split('\n').length)
  })

  it('preserves char literals (single chars are code, not strings)', () => {
    const src = "char c = 'x';"
    const out = stripStrings(src)
    expect(out).toBe(src)
  })

  it('preserves char literals with escapes', () => {
    const src = String.raw`char c = '\n';`
    const out = stripStrings(src)
    expect(out).toBe(src)
  })

  it('preserves newlines inside text blocks', () => {
    const src = 'String x = """\nline1\nline2\n""";'
    const out = stripStrings(src)
    expect(out.length).toBe(src.length)
    expect(out.split('\n').length).toBe(src.split('\n').length)
  })

  it('handles escapes inside regular strings', () => {
    const src = String.raw`String s = "a\"b";`
    const out = stripStrings(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain(String.raw`a\"b`)
  })
})

describe('java stripComments', () => {
  it('replaces line comments', () => {
    const src = 'int x = 1; // comment'
    const out = stripComments(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('comment')
    expect(out).toContain('int x = 1;')
  })

  it('replaces block comments', () => {
    const src = 'int x = /* hi */ 2;'
    const out = stripComments(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('hi')
    expect(out).toContain('int x =')
    expect(out).toContain('2;')
  })

  it('does not nest block comments (Java semantics)', () => {
    // The first */ closes the block; the second one is plain code.
    const src = 'int x = /* outer /* inner */ rest */ 1;'
    const out = stripComments(src)
    expect(out.length).toBe(src.length)
    // The inner section is replaced
    expect(out).not.toContain('outer')
    expect(out).not.toContain('inner')
    // ...but the trailing `rest */ 1;` is back in code-land
    expect(out).toContain('rest')
  })

  it('strips strings as well as comments', () => {
    const src = 'String s = "// not a comment";'
    const out = stripComments(src)
    expect(out.length).toBe(src.length)
    // The `// not a comment` was a STRING, not a comment, but stripComments
    // replaces both kinds of regions.
    expect(out).not.toContain('not a comment')
    // The outer structure (assignment, semicolon, quotes) is intact
    expect(out).toContain('String s =')
    expect(out).toContain('"')
    expect(out).toContain(';')
  })
})
