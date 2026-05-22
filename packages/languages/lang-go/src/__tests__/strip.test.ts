import { describe, expect, it } from 'vitest';

import { stripStrings, stripComments } from '../strip.js';

describe('stripStrings (Go)', () => {
  it('strips double-quoted strings', () => {
    const out = stripStrings('s := "hello"');
    expect(out).not.toContain('hello');
  });

  it('strips raw (backtick) strings', () => {
    const out = stripStrings('s := `multi\nline`');
    expect(out).not.toContain('multi');
    expect(out).not.toContain('line');
  });

  it('handles escape sequences in double-quoted strings', () => {
    const out = stripStrings(String.raw`s := "a\"b"`);
    expect(out).not.toContain('a');
  });

  it('preserves rune literals (no stripping)', () => {
    expect(stripStrings("c := 'a'")).toContain("'a'");
  });

  it('preserves rune literals with escape', () => {
    expect(stripStrings(String.raw`c := '\n'`)).toContain(String.raw`'\n'`);
  });

  it('handles unterminated rune literal at newline', () => {
    const out = stripStrings("c := 'oops\nx := 1");
    expect(out).toContain('x := 1');
  });

  it('handles unterminated double-quoted string', () => {
    const out = stripStrings('s := "unterminated');
    expect(out).toContain('s := ');
  });

  it('passes through code with no string-like tokens unchanged', () => {
    const code = 'func foo() int { return 1 }';
    expect(stripStrings(code)).toBe(code);
  });
});

describe('stripComments (Go)', () => {
  it('strips line comments', () => {
    const out = stripComments('x := 1 // comment');
    expect(out).not.toContain('comment');
    expect(out).toContain('x := 1');
  });

  it('strips block comments', () => {
    const out = stripComments('x := 1 /* hidden */ y := 2');
    expect(out).not.toContain('hidden');
    expect(out).toContain('x := 1');
    expect(out).toContain('y := 2');
  });

  it('handles unterminated block comment', () => {
    const out = stripComments('x := 1 /* oops');
    expect(out).toContain('x := 1');
  });
});
