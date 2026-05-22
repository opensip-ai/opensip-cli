import { describe, expect, it } from 'vitest';

import { stripStrings, stripComments } from '../strip.js';

describe('stripStrings (Java)', () => {
  it('strips double-quoted strings', () => {
    const out = stripStrings('String s = "hello";');
    expect(out).not.toContain('hello');
  });

  it('strips text blocks (triple-quoted multi-line strings)', () => {
    const src = 'String s = """\nline1\nline2\n""";';
    const out = stripStrings(src);
    expect(out).not.toContain('line1');
    expect(out).not.toContain('line2');
  });

  it('handles escape sequences', () => {
    const out = stripStrings(String.raw`String s = "a\"b";`);
    expect(out).not.toContain('a');
  });

  it('preserves char literals', () => {
    expect(stripStrings("char c = 'a';")).toContain("'a'");
  });

  it('handles unterminated string', () => {
    const out = stripStrings('String s = "unterminated');
    expect(out).toContain('String s = ');
  });

  it('passes through code with no strings unchanged', () => {
    const code = 'class Foo { int x = 1; }';
    expect(stripStrings(code)).toBe(code);
  });

  it('handles unterminated text block', () => {
    const out = stripStrings('String s = """\nunterminated');
    expect(out).toContain('String s = ');
    expect(out).not.toContain('unterminated');
  });

  it('handles char literal hitting a newline before closing quote', () => {
    const out = stripStrings("char c = 'unterminated\nint x = 1;");
    expect(out).toContain('int x = 1;');
  });
});

describe('stripComments (Java)', () => {
  it('strips line comments', () => {
    const out = stripComments('int x = 1; // comment');
    expect(out).not.toContain('comment');
  });

  it('strips block comments', () => {
    const out = stripComments('int x = 1; /* hidden */ int y = 2;');
    expect(out).not.toContain('hidden');
  });

  it('strips javadoc-style comments', () => {
    const out = stripComments('/** doc */\nclass Foo {}');
    expect(out).not.toContain('doc');
  });

  it('handles unterminated block comment', () => {
    const out = stripComments('int x = 1; /* oops');
    expect(out).toContain('int x = 1;');
  });
});
