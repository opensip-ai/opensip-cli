import { describe, expect, it } from 'vitest';

import { stripStrings, stripComments } from '../strip.js';

describe('stripStrings (C/C++)', () => {
  it('strips double-quoted strings', () => {
    const out = stripStrings('const char* s = "hello";');
    expect(out).not.toContain('hello');
  });

  it('strips raw string literals', () => {
    const src = 'const char* s = R"foo(line1\nline2)foo";';
    const out = stripStrings(src);
    expect(out).not.toContain('line1');
    expect(out).not.toContain('line2');
  });

  it('strips wide-char and Unicode-prefixed strings (L"...", u"...", U"...", u8"...")', () => {
    expect(stripStrings('auto a = L"wide";')).not.toContain('wide');
    expect(stripStrings('auto b = u"u16";')).not.toContain('u16');
    expect(stripStrings('auto c = U"u32";')).not.toContain('u32');
    expect(stripStrings('auto d = u8"u8s";')).not.toContain('u8s');
  });

  it('handles unterminated raw string', () => {
    const out = stripStrings('const char* s = R"foo(unterminated');
    expect(out).toContain('const char* s = ');
    expect(out).not.toContain('unterminated');
  });

  it('handles unterminated regular string', () => {
    const out = stripStrings('const char* s = "unterminated');
    expect(out).toContain('const char* s = ');
  });

  it('preserves char literals', () => {
    expect(stripStrings("char c = 'a';")).toContain("'a'");
  });

  it('handles char literal that overruns the 8-char scan window', () => {
    // The scan looks at most 8 chars for the closing quote; an oversized
    // char literal exits the scan fallback and just advances by one.
    const out = stripStrings("char c = 'this_is_too_long");
    expect(out).toContain('char c = ');
  });

  it('passes through code with no strings unchanged', () => {
    const code = 'int main() { return 0; }';
    expect(stripStrings(code)).toBe(code);
  });

  it('preserves wide-char and Unicode-prefixed char literals', () => {
    expect(stripStrings("auto a = L'A';")).toContain("L'A'");
    expect(stripStrings("auto b = u'B';")).toContain("u'B'");
    expect(stripStrings("auto c = U'C';")).toContain("U'C'");
  });

  it('preserves char literal with escape sequence', () => {
    expect(stripStrings("char c = '\\n';")).toContain("'\\n'");
  });

  it('handles u8R, uR, UR, LR raw-string prefixes', () => {
    const variants = [
      'auto s = u8R"foo(payload)foo";',
      'auto s = uR"foo(payload)foo";',
      'auto s = UR"foo(payload)foo";',
      'auto s = LR"foo(payload)foo";',
    ];
    for (const src of variants) {
      const out = stripStrings(src);
      expect(out).not.toContain('payload');
    }
  });
});

describe('stripComments (C/C++)', () => {
  it('strips line comments', () => {
    const out = stripComments('int x = 1; // comment');
    expect(out).not.toContain('comment');
  });

  it('strips block comments', () => {
    const out = stripComments('int x = 1; /* hidden */ int y = 2;');
    expect(out).not.toContain('hidden');
    expect(out).toContain('int x = 1;');
    expect(out).toContain('int y = 2;');
  });

  it('handles unterminated block comment', () => {
    const out = stripComments('int x = 1; /* oops');
    expect(out).toContain('int x = 1;');
  });
});
