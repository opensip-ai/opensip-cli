/**
 * Edge-case tests for the Rust string/comment stripper.
 *
 * The hand-written lexer in `strip.ts` has several state-machine branches
 * that aren't exercised by the basic happy-path coverage in
 * `adapter.test.ts`: unterminated literals, raw-string ambiguity, char
 * literals with escapes, lifetime annotations next to weird tokens, and
 * `\x` / `\u{...}` escape sequences inside regular strings.
 *
 * Each test in this file targets one of those branches so that a future
 * regression — say, off-by-one on the unterminated-string fallback — gets
 * caught by CI rather than discovered in a real Rust file.
 */

import { describe, expect, it } from 'vitest';

import { stripComments, stripStrings } from '../strip.js';

describe('rust stripStrings — unterminated literals', () => {
  it('records an unterminated regular string up to EOF', () => {
    const src = 'let s = "unterminated string';
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    // "unterminated" should be replaced by whitespace
    expect(out).not.toContain('unterminated');
    expect(out).not.toContain('string');
    expect(out.startsWith('let s = "')).toBe(true);
  });

  it('records an unterminated raw string up to EOF', () => {
    // r#"..."# but the closing #" never appears
    const src = 'let s = r#"never closes';
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('never');
    expect(out).not.toContain('closes');
  });

  it('records an unterminated raw string with multiple hashes', () => {
    const src = 'let s = r##"opening but missing close';
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('opening');
    expect(out).not.toContain('missing');
  });
});

describe('rust stripStrings — `r` ambiguity', () => {
  // The lexer enters the raw-string branch whenever `r` is followed by `"`
  // or `#`. If it then runs out of input before finding a `"`, it has to
  // back out (treat the `r` as a normal identifier character) and advance
  // by one. These inputs hit that fallback.
  it('treats trailing `r#` (no quote) as identifier-like, not as a raw string', () => {
    const src = 'let r###';
    // Should not throw, should not hang, should not strip anything
    const out = stripStrings(src);
    expect(out).toBe(src);
  });

  it('treats `r##` followed by non-quote text as not-a-raw-string', () => {
    const src = 'fn foo() { r##xyz }';
    const out = stripStrings(src);
    // Nothing was a string, so output equals input
    expect(out).toBe(src);
  });
});

describe('rust stripStrings — char literals and lifetimes', () => {
  it(String.raw`handles char literal with escape: \n`, () => {
    const src = String.raw`let c = '\n';`;
    const out = stripStrings(src);
    // Char literals are preserved as-is by the stripper
    expect(out).toBe(src);
  });

  it(String.raw`handles char literal with escaped quote: \'`, () => {
    const src = String.raw`let c = '\'';`;
    const out = stripStrings(src);
    expect(out).toBe(src);
  });

  it(String.raw`handles char literal with unicode escape: \u{1F600}`, () => {
    const src = String.raw`let c = '\u{1F600}';`;
    const out = stripStrings(src);
    expect(out).toBe(src);
  });

  it('treats trailing apostrophe at EOF as a lifetime-style token', () => {
    // After-byte is undefined — the lexer's safety branch.
    const src = "let x = 1;'";
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
  });

  it('distinguishes a char literal from a lifetime when both are nearby', () => {
    const src = "fn f<'a>() { let c = 'x'; let _: &'a str; }";
    const out = stripStrings(src);
    // Lifetimes 'a remain; char 'x' is preserved as code (not stripped).
    expect(out).toContain("'a");
    expect(out).toContain("'x'");
  });

  it('handles a lifetime followed by an escape-like sequence in scan window', () => {
    // 'static is a long lifetime — no closing quote within ~6 chars.
    const src = 'fn foo() -> &\'static str { "hi" }';
    const out = stripStrings(src);
    // 'static must survive
    expect(out).toContain("'static");
    // The "hi" content should be stripped
    expect(out).not.toContain('hi');
  });
});

describe('rust stripStrings — regular-string escape sequences', () => {
  it(String.raw`handles \x## hex escapes inside regular strings`, () => {
    const src = String.raw`let s = "before\x41after";`;
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('before');
    expect(out).not.toContain('after');
    // The opening/closing quotes must remain
    expect(out).toContain('let s = "');
  });

  it(String.raw`handles \u{...} unicode escapes inside regular strings`, () => {
    const src = String.raw`let s = "emoji\u{1F600}tail";`;
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('emoji');
    expect(out).not.toContain('tail');
  });

  it(String.raw`handles \u without braces (treat as 2-char escape)`, () => {
    // The lexer's else-branch for \u not followed by `{`: it advances 2
    // more chars after the initial \u consumption.
    const src = String.raw`let s = "xꮫ y";`;
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('y');
  });

  it(String.raw`handles unterminated \u{...} escape that runs to EOF`, () => {
    // \u{ with no closing brace — exercises the inner while-loop bound.
    const src = String.raw`let s = "x\u{12345`;
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
  });

  it(String.raw`handles \\ (escaped backslash) inside a string`, () => {
    const src = String.raw`let s = "a\\b";`;
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain(String.raw`a\b`);
  });

  it('strips byte string content with escapes', () => {
    const src = String.raw`let b = b"\x00\x01end";`;
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('end');
  });

  it('handles byte-raw strings br"..."', () => {
    const src = String.raw`let b = br"raw\bytes";`;
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('raw');
    expect(out).not.toContain('bytes');
  });

  it('handles byte-raw strings with hashes br#"..."#', () => {
    const src = 'let b = br#"has "quotes" within"#;';
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('quotes');
    expect(out).not.toContain('within');
  });
});

describe('rust stripComments — additional cases', () => {
  it('handles unterminated block comment (runs to EOF)', () => {
    const src = 'let x = 1; /* unterminated\nmore content';
    const out = stripComments(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('unterminated');
    expect(out).not.toContain('more content');
    expect(out).toContain('let x = 1;');
  });

  it('preserves newline structure inside block comments', () => {
    const src = '/* a\n b\n c */let x = 1;';
    const out = stripComments(src);
    expect(out.length).toBe(src.length);
    expect(out.split('\n').length).toBe(src.split('\n').length);
    expect(out).toContain('let x = 1;');
  });

  it('handles a comment immediately followed by a string', () => {
    const src = '/*c*/"s"';
    const out = stripComments(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('c');
    expect(out).not.toContain('s');
    expect(out).toContain('"');
  });
});
