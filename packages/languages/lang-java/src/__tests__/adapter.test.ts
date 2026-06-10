import { describe, expect, it } from 'vitest';

import { javaAdapter } from '../adapter.js';
import { stripComments, stripStrings } from '../strip.js';

describe('javaAdapter', () => {
  it('declares the expected identity and extension', () => {
    expect(javaAdapter.id).toBe('java');
    expect(javaAdapter.fileExtensions).toContain('.java');
  });

  it('parse() returns a real tree-sitter tree + source', () => {
    const src = 'class A {\n  void m() {}\n}';
    const tree = javaAdapter.parse(src, 'A.java');
    expect(tree).not.toBeNull();
    expect(tree?.source).toBe(src);
    expect(tree?.tree.rootNode.type).toBe('program');
  });
});

describe('java stripStrings', () => {
  it('replaces regular string content but preserves length', () => {
    const src = 'String s = "hello world";';
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('hello');
    expect(out).toContain('String s =');
    expect(out).toContain('"');
  });

  it('strips text block body but preserves the triple quotes and newlines', () => {
    const src = 'String s = """\nfoo bar\n""";';
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('foo');
    expect(out).not.toContain('bar');
    // Triple quotes (delimiters) survive
    expect(out).toContain('"""');
    // Newlines are preserved
    expect(out.split('\n').length).toBe(src.split('\n').length);
  });

  it('preserves char literals (single chars are code, not strings)', () => {
    const src = "char c = 'x';";
    const out = stripStrings(src);
    expect(out).toBe(src);
  });

  it('preserves char literals with escapes', () => {
    const src = String.raw`char c = '\n';`;
    const out = stripStrings(src);
    expect(out).toBe(src);
  });

  it('preserves newlines inside text blocks', () => {
    const src = 'String x = """\nline1\nline2\n""";';
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out.split('\n').length).toBe(src.split('\n').length);
  });

  it('handles escapes inside regular strings', () => {
    const src = String.raw`String s = "a\"b";`;
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain(String.raw`a\"b`);
  });

  // F1: text-block scanner must honor backslash escapes per JLS §3.10.6.
  // A literal `\"""` inside a text block is a backslash, an escaped quote,
  // then two literal quotes — NOT a closing delimiter.
  it('does not prematurely close a text block on an escaped triple quote', () => {
    const src = 'String s = """\n  literal \\""" inside\n  """;\nint after = 1;';
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    // Body content should be stripped
    expect(out).not.toContain('literal');
    expect(out).not.toContain('inside');
    // The trailing code outside the text block must NOT be stripped
    expect(out).toContain('int after = 1;');
  });

  // F1: graceful end-of-source recovery when a text block is unterminated.
  it('recovers from an unterminated text block at end of source', () => {
    const src = 'String s = """\n unterminated';
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('unterminated');
    // Outer prefix is preserved
    expect(out).toContain('String s =');
    expect(out).toContain('"""');
  });

  // N2: when `"""` is NOT followed by a line terminator, the text-block
  // detection must fall through to the regular-string branch. Pin the
  // happy path through that fall-through so a future change in
  // scanRegularString's empty-string fast path does not silently break
  // Java's not-a-text-block semantics.
  it(String.raw`falls through to regular-string when """ has no following line terminator`, () => {
    // `String s = """abc";` — the leading `""` is an empty regular
    // string; the third `"` opens a new regular string with body `abc`,
    // closing at the trailing `"`. Result: both string regions are
    // stripped, and the surrounding code structure survives.
    const src = 'String s = """abc";';
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    // The body content is stripped.
    expect(out).not.toContain('abc');
    // Outer code structure survives — no scanner spin.
    expect(out).toContain('String s =');
    expect(out).toContain(';');
  });

  // F2: stray apostrophe in malformed input must not swallow following code.
  it('does not swallow code on a stray apostrophe (malformed input)', () => {
    const src = "char c = 'a; int x = 1;";
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    // The trailing statement is real code and must survive intact
    expect(out).toContain('int x = 1;');
  });

  // F2: a unicode-escape char literal (`'A'` = 8 chars including quotes)
  // must still close inside the 8-char scan cap.
  it('closes a unicode-escape char literal within the 8-char cap', () => {
    const src = String.raw`char c = 'A'; int x = 1;`;
    const out = stripStrings(src);
    expect(out).toBe(src);
    expect(out).toContain('int x = 1;');
  });

  // F6: '\'' is the canonical case where the escape branch must run before
  // the closing-quote branch. If the order is wrong, this test fails.
  it(String.raw`parses an escaped-apostrophe char literal '\''`, () => {
    const src = String.raw`char c = '\''; int x = 1;`;
    const out = stripStrings(src);
    expect(out).toBe(src);
    // Followup statement must not be eaten
    expect(out).toContain('int x = 1;');
  });
});

describe('java stripComments', () => {
  it('replaces line comments', () => {
    const src = 'int x = 1; // comment';
    const out = stripComments(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('comment');
    expect(out).toContain('int x = 1;');
  });

  it('replaces block comments', () => {
    const src = 'int x = /* hi */ 2;';
    const out = stripComments(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('hi');
    expect(out).toContain('int x =');
    expect(out).toContain('2;');
  });

  it('does not nest block comments (Java semantics)', () => {
    // The first */ closes the block; the second one is plain code.
    const src = 'int x = /* outer /* inner */ rest */ 1;';
    const out = stripComments(src);
    expect(out.length).toBe(src.length);
    // The inner section is replaced
    expect(out).not.toContain('outer');
    expect(out).not.toContain('inner');
    // ...but the trailing `rest */ 1;` is back in code-land
    expect(out).toContain('rest');
  });

  it('strips strings as well as comments', () => {
    const src = 'String s = "// not a comment";';
    const out = stripComments(src);
    expect(out.length).toBe(src.length);
    // The `// not a comment` was a STRING, not a comment, but stripComments
    // replaces both kinds of regions.
    expect(out).not.toContain('not a comment');
    // The outer structure (assignment, semicolon, quotes) is intact
    expect(out).toContain('String s =');
    expect(out).toContain('"');
    expect(out).toContain(';');
  });
});
