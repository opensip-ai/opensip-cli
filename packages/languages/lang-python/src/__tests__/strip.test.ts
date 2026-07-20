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

describe('stripStrings · PEP 701 nested-quote f-strings (2026-07-20 regression)', () => {
  // Python 3.12+ lets an f-string expression reuse the string's own quote
  // character, e.g. f"{d["key"]}". A quote scanner that isn't aware of the
  // `{...}` expression must not treat that inner quote as the string's
  // terminator — doing so leaks the dict-key literal unstripped and
  // misclassifies the rest of the f-string body.
  it('fully blanks a same-quote-nested f-string body', () => {
    const out = stripStrings('x = f"{d["key"]}"');
    expect(out).toBe('x = f"          "');
  });

  it('does not leak nested literal content as unstripped code', () => {
    const out = stripStrings('x = f"{d["key"]}"');
    expect(out).not.toContain('key');
  });

  it('does not corrupt stripping on a following line', () => {
    const out = stripStrings(['x = f"{d["key"]}"', 'password = "hunter2"'].join('\n'));
    expect(out).not.toContain('hunter2');
    expect(out).toContain('password = "');
  });

  it('still recognizes a real comment immediately after the f-string', () => {
    const out = stripComments('x = f"{d["key"]}" # secret');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('key');
  });

  it('handles a same-quote-nested triple-quoted f-string', () => {
    const out = stripStrings('x = f"""{d["key"]}"""');
    expect(out).not.toContain('key');
  });

  it('leaves non-f-string same-quote content unaffected', () => {
    // Sanity: the new brace-depth tracking is gated on the f-prefix, so a
    // plain string containing `{`/`}` text is unaffected.
    const out = stripStrings('x = "{d[" + "key" + "]}"');
    expect(out).not.toContain('key');
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
