import { describe, expect, it } from 'vitest'

import { cppAdapter } from '../adapter.js'
import { stripComments, stripStrings } from '../strip.js'

describe('cppAdapter', () => {
  it('declares the expected identity and extensions', () => {
    expect(cppAdapter.id).toBe('cpp')
    expect(cppAdapter.fileExtensions).toContain('.cpp')
    expect(cppAdapter.fileExtensions).toContain('.h')
    expect(cppAdapter.aliases).toContain('c')
  })

  it('parse() returns null (C/C++ uses clang-tidy CommandConfig instead)', () => {
    expect(cppAdapter.parse('int main() { return 0; }', 'foo.cpp')).toBeNull()
  })
})

describe('cpp stripStrings', () => {
  it('replaces regular string content', () => {
    const src = 'std::string s = "hello";'
    const out = stripStrings(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('hello')
    expect(out).toContain('std::string s =')
  })

  it('handles backslash escapes inside strings', () => {
    const src = String.raw`X = "needle\"middle"; Y`
    const out = stripStrings(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('needle')
    expect(out).not.toContain('middle')
    expect(out).toContain('X = ')
    expect(out).toContain('; Y')
  })

  it('handles raw strings R"(...)"', () => {
    const src = 'auto s = R"(raw "with quotes" inside)";'
    const out = stripStrings(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('raw')
    expect(out).not.toContain('quotes')
  })

  it('handles raw strings with delimiter R"d(...)d"', () => {
    const src = 'auto s = R"xx(payload)xx";'
    const out = stripStrings(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('payload')
  })

  it('preserves char literals', () => {
    const src = "char c = 'x';"
    const out = stripStrings(src)
    expect(out).toBe(src)
  })

  it('preserves newlines inside multi-line raw strings', () => {
    const src = 'auto s = R"(\nline1\nline2\n)";'
    const out = stripStrings(src)
    expect(out.length).toBe(src.length)
    expect(out.split('\n').length).toBe(src.split('\n').length)
  })
})

describe('cpp stripComments', () => {
  it('replaces line comments', () => {
    const src = 'int x = 1; // line comment'
    const out = stripComments(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('line comment')
    expect(out).toContain('int x = 1;')
  })

  it('replaces block comments (no nesting)', () => {
    const src = 'int x = /* block */ 1;'
    const out = stripComments(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('block')
  })

  it('treats /* /* */ as one block comment ending at first */', () => {
    const src = 'int x = /* outer /* inner */ remaining */ 1;'
    const out = stripComments(src)
    // Block comment is /* outer /* inner */ — `remaining */ 1;` survives as code
    expect(out).toContain('remaining')
  })

  it('also strips strings', () => {
    const src = '// hello\nauto s = "secret";'
    const out = stripComments(src)
    expect(out).not.toContain('secret')
    expect(out).not.toContain('hello')
  })
})
