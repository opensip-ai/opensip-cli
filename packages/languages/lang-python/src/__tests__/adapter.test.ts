import { describe, expect, it } from 'vitest'

import { pythonAdapter } from '../adapter.js'
import { stripComments, stripStrings } from '../strip.js'

describe('pythonAdapter', () => {
  it('declares the expected identity and extensions', () => {
    expect(pythonAdapter.id).toBe('python')
    expect(pythonAdapter.fileExtensions).toContain('.py')
    expect(pythonAdapter.fileExtensions).toContain('.pyi')
    expect(pythonAdapter.aliases).toContain('py')
  })

  it('parse() returns a tree with line starts', () => {
    const tree = pythonAdapter.parse('def main():\n    print("hi")\n', 'foo.py')
    expect(tree).not.toBeNull()
    expect(tree?.filePath).toBe('foo.py')
    expect(tree?.lineStarts.length).toBe(3)
  })
})

describe('python stripStrings', () => {
  it('replaces single-quoted string content but preserves length', () => {
    const src = "x = 'hello'"
    const out = stripStrings(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('hello')
    expect(out).toContain('x =')
    expect(out).toContain("'")
  })

  it('replaces double-quoted string content', () => {
    const src = 'x = "hello"'
    const out = stripStrings(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('hello')
    expect(out).toContain('x =')
    expect(out).toContain('"')
  })

  it("handles triple-single-quoted strings ('''...''')", () => {
    const src = "x = '''hello\nworld'''"
    const out = stripStrings(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('hello')
    expect(out).not.toContain('world')
    expect(out).toContain('x =')
    // Newline must survive
    expect(out.split('\n').length).toBe(src.split('\n').length)
  })

  it('handles triple-double-quoted strings ("""..."""")', () => {
    const src = 'x = """hello\nworld"""'
    const out = stripStrings(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('hello')
    expect(out).not.toContain('world')
    expect(out).toContain('x =')
    expect(out.split('\n').length).toBe(src.split('\n').length)
  })

  it('handles raw string prefix r"..."', () => {
    const src = 'x = r"raw"'
    const out = stripStrings(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('raw')
    expect(out).toContain('x = r"')
  })

  it("handles bytes prefix b'...'", () => {
    const src = "x = b'bytes'"
    const out = stripStrings(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('bytes')
    expect(out).toContain("x = b'")
  })

  it('handles f-string prefix f"..." (entire body stripped — known limitation)', () => {
    const src = 'x = f"hello {name}"'
    const out = stripStrings(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('hello')
    // Documented limitation: expression interpolation is treated as
    // string content, so {name} is also stripped.
    expect(out).not.toContain('name')
    expect(out).toContain('x = f"')
  })

  it('handles two-letter prefixes (rb, br, rf, fr) case-insensitively', () => {
    const cases = ['rb', 'br', 'rf', 'fr', 'RB', 'Br', 'rF']
    for (const prefix of cases) {
      const src = `x = ${prefix}'payload'`
      const out = stripStrings(src)
      expect(out.length).toBe(src.length)
      expect(out).not.toContain('payload')
    }
  })

  it("preserves identifiers that begin with prefix-like letters (e.g. 'broken')", () => {
    // `broken` is an identifier, NOT a `b` prefix followed by `roken`.
    const src = 'broken = 1'
    const out = stripStrings(src)
    expect(out).toBe(src)
  })
})

describe('python stripComments', () => {
  it('replaces line comments and keeps the code', () => {
    const src = 'x = 1  # comment'
    const out = stripComments(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('comment')
    expect(out).toContain('x = 1')
  })

  it('does NOT treat # inside a string literal as a comment', () => {
    const src = 'x = "hash inside #not a comment"'
    const out = stripComments(src)
    expect(out.length).toBe(src.length)
    // The string content (including the #) is stripped, but the code
    // surrounding it (the assignment) remains intact.
    expect(out).toContain('x =')
    expect(out).toContain('"')
    expect(out).not.toContain('not a comment')
    // Critically: the trailing `"` survives — proving we didn't run
    // off the end thinking the # started a comment.
    expect(out.endsWith('"')).toBe(true)
  })

  it('strips both strings and comments', () => {
    const src = '# header\nx = "secret"'
    const out = stripComments(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('header')
    expect(out).not.toContain('secret')
  })

  it('preserves newlines when stripping multi-line triple strings', () => {
    const src = 'x = """one\ntwo\nthree"""\n# trailing'
    const out = stripComments(src)
    expect(out.length).toBe(src.length)
    expect(out.split('\n').length).toBe(src.split('\n').length)
    expect(out).not.toContain('one')
    expect(out).not.toContain('trailing')
  })
})
