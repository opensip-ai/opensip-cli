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

  it('preserves single-char baseline (length-preserving)', () => {
    const src = "char c = 'A';"
    const out = stripStrings(src)
    expect(out).toBe(src)
    expect(out.length).toBe(src.length)
  })

  it('preserves u8 char-literal prefix (C++17)', () => {
    // F5a: u8'a' is a valid C++17 char literal opener.
    const src = "char c = u8'a';"
    const out = stripStrings(src)
    expect(out).toBe(src)
    expect(out.length).toBe(src.length)
  })

  it('preserves u, U, and L char-literal prefixes', () => {
    const srcs = ["char16_t c = u'a';", "char32_t c = U'a';", "wchar_t c = L'a';"]
    for (const src of srcs) {
      const out = stripStrings(src)
      expect(out).toBe(src)
    }
  })

  it('handles char literals with long unicode escape sequences', () => {
    // F5b: previously `maxScan = startQuote + 8` cut off literals like
    // '\u{1F600}' (10 chars between quotes) — should now scan to the
    // closing quote.
    const src = String.raw`char32_t c = '\u{1F600}'; int x = 1;`
    const out = stripStrings(src)
    expect(out.length).toBe(src.length)
    // The char literal should be preserved as code, and the trailing
    // `int x = 1;` must remain intact (i.e. not consumed as if the
    // literal were unterminated).
    expect(out).toContain('int x = 1;')
    expect(out).toContain(String.raw`'\u{1F600}'`)
  })
})

describe('cpp stripComments line-continuation (F3)', () => {
  it('continues a // line comment past a backslash-newline splice', () => {
    // F3: in C/C++, `\<newline>` is a line splice (translation phase 2).
    // The // comment should swallow the second physical line as well,
    // and scanning should resume at `int x = 1;`.
    const src = '// comment continued\\\nstill comment\nint x = 1;'
    const out = stripComments(src)
    expect(out.length).toBe(src.length)
    // Both halves of the spliced comment should be stripped.
    expect(out).not.toContain('comment continued')
    expect(out).not.toContain('still comment')
    // Code after the splice survives.
    expect(out).toContain('int x = 1;')
  })

  it('does not over-extend when there is no backslash before the newline', () => {
    const src = '// comment\nint x = 1;'
    const out = stripComments(src)
    expect(out.length).toBe(src.length)
    expect(out).not.toContain('comment')
    expect(out).toContain('int x = 1;')
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
