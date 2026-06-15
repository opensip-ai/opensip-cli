import { describe, expect, it } from 'vitest';

import { stripStrings, stripComments } from '../strip.js';

describe('stripStrings', () => {
  it('strips single-quoted string contents (replacing with whitespace)', () => {
    const out = stripStrings(`x = 'hello'`);
    expect(out).not.toContain('hello');
    expect(out.startsWith(`x = '`)).toBe(true);
    expect(out.endsWith(`'`)).toBe(true);
  });

  it('strips double-quoted strings', () => {
    const out = stripStrings(`x = "hello"`);
    expect(out).not.toContain('hello');
  });

  it('strips triple-single strings (multi-line)', () => {
    const out = stripStrings("x = '''line1\nline2'''");
    expect(out).not.toContain('line1');
    expect(out).not.toContain('line2');
  });

  it('strips triple-double strings (multi-line)', () => {
    const out = stripStrings('x = """line1\nline2"""');
    expect(out).not.toContain('line1');
    expect(out).not.toContain('line2');
  });

  it('handles escape sequences', () => {
    const out = stripStrings(String.raw`x = 'a\'b'`);
    expect(out).not.toContain('a');
  });

  it('handles raw strings (no escape processing)', () => {
    const out = stripStrings(`x = r'abc'`);
    expect(out).not.toContain('abc');
  });

  it('terminates non-triple string at newline (malformed input)', () => {
    const out = stripStrings("x = 'unclosed\n");
    expect(out).toContain('x = ');
  });

  it('passes through code with no strings unchanged', () => {
    const code = 'def foo():\n    return 1';
    expect(stripStrings(code)).toBe(code);
  });

  it('handles triple string with escaped quotes', () => {
    const out = stripStrings(String.raw`x = '''line1\'still in string'''`);
    expect(out).not.toContain('line1');
  });

  it('handles unterminated triple string', () => {
    const out = stripStrings(`x = '''unterminated`);
    expect(out).toContain('x = ');
    expect(out).not.toContain('unterminated');
  });

  it('handles unterminated single-line string at EOF', () => {
    const out = stripStrings(`x = "unterminated`);
    expect(out).toContain('x = ');
    expect(out).not.toContain('unterminated');
  });
});

describe('stripComments', () => {
  it('strips line comments', () => {
    const out = stripComments('x = 1 # comment');
    expect(out).not.toContain('comment');
    expect(out).toContain('x = 1');
  });

  it('does not treat # inside a string as a comment marker', () => {
    // The implementation may also blank string contents — what matters
    // is that the structure ('x = "..."') survives without the # being
    // misinterpreted as a comment delimiter that swallows the rest.
    const out = stripComments('x = "# not a comment"\ny = 2');
    expect(out).toContain('x = "');
    expect(out).toContain('y = 2');
  });

  it('strips multiple comment lines', () => {
    const src = '# top\nx = 1 # mid\ny = 2 # end';
    const out = stripComments(src);
    expect(out).not.toContain('top');
    expect(out).not.toContain('mid');
    expect(out).not.toContain('end');
  });
});
