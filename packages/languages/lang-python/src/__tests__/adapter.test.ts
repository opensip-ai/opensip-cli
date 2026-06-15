import { describe, expect, it } from 'vitest';

import { pythonAdapter } from '../adapter.js';
import { stripComments, stripStrings } from '../strip.js';

describe('pythonAdapter', () => {
  it('declares the expected identity and extensions', () => {
    expect(pythonAdapter.id).toBe('python');
    expect(pythonAdapter.fileExtensions).toContain('.py');
    expect(pythonAdapter.fileExtensions).toContain('.pyi');
    expect(pythonAdapter.aliases).toContain('py');
  });

  it('parse() returns a real tree-sitter tree + source', () => {
    const src = 'def main():\n    print("hi")\n';
    const tree = pythonAdapter.parse(src, 'foo.py');
    expect(tree).not.toBeNull();
    expect(tree?.source).toBe(src);
    expect(tree?.tree.rootNode.type).toBe('module');
  });
});

describe('python stripStrings', () => {
  it('replaces single-quoted string content but preserves length', () => {
    const src = "x = 'hello'";
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('hello');
    expect(out).toContain('x =');
    expect(out).toContain("'");
  });

  it('replaces double-quoted string content', () => {
    const src = 'x = "hello"';
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('hello');
    expect(out).toContain('x =');
    expect(out).toContain('"');
  });

  it("handles triple-single-quoted strings ('''...''')", () => {
    const src = "x = '''hello\nworld'''";
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('hello');
    expect(out).not.toContain('world');
    expect(out).toContain('x =');
    // Newline must survive
    expect(out.split('\n').length).toBe(src.split('\n').length);
  });

  it('handles triple-double-quoted strings ("""..."""")', () => {
    const src = 'x = """hello\nworld"""';
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('hello');
    expect(out).not.toContain('world');
    expect(out).toContain('x =');
    expect(out.split('\n').length).toBe(src.split('\n').length);
  });

  it('handles raw string prefix r"..."', () => {
    const src = 'x = r"raw"';
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('raw');
    expect(out).toContain('x = r"');
  });

  it("handles bytes prefix b'...'", () => {
    const src = "x = b'bytes'";
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('bytes');
    expect(out).toContain("x = b'");
  });

  it('handles f-string prefix f"..." (entire body stripped — known limitation)', () => {
    const src = 'x = f"hello {name}"';
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('hello');
    // Documented limitation: expression interpolation is treated as
    // string content, so {name} is also stripped.
    expect(out).not.toContain('name');
    expect(out).toContain('x = f"');
  });

  it('handles two-letter prefixes (rb, br, rf, fr) case-insensitively', () => {
    const cases = ['rb', 'br', 'rf', 'fr', 'RB', 'Br', 'rF'];
    for (const prefix of cases) {
      const src = `x = ${prefix}'payload'`;
      const out = stripStrings(src);
      expect(out.length).toBe(src.length);
      expect(out).not.toContain('payload');
    }
  });

  it("preserves identifiers that begin with prefix-like letters (e.g. 'broken')", () => {
    // `broken` is an identifier, NOT a `b` prefix followed by `roken`.
    const src = 'broken = 1';
    const out = stripStrings(src);
    expect(out).toBe(src);
  });

  describe('tokenization semantics for backslash-quote (raw and non-raw alike)', () => {
    // These cases are framed as raw-string tests because that is where
    // the original bug surfaced (post-Wave-1, see strip.ts function
    // header on `matchStringStart`). The underlying tokenization rule —
    // backslash always pairs with the following character for the
    // purpose of finding the string terminator — applies to non-raw
    // strings too. The strip pass does not distinguish raw vs non-raw
    // because it is region-bound, not value-extraction.
    //
    // CPython rule for raw strings: backslash is ordinary EXCEPT when
    // followed by a quote — `\"` or `\'` keep both chars as part of
    // the string and the quote does NOT terminate the literal. Without
    // this rule, the scanner would close on the wrong quote and leak
    // string content into the surrounding code.

    it(String.raw`r"\"" — backslash-quote does not terminate the literal`, () => {
      // Source: x = r"\"" + "tail"
      //                ^ this " is escaped (still part of raw string)
      //                  the *next* " (the third) is the real terminator
      const src = String.raw`x = r"\"" + "tail"`;
      const out = stripStrings(src);
      expect(out.length).toBe(src.length);
      // The literal "tail" must remain stripped properly — meaning
      // the scanner correctly identified its open and close quotes.
      expect(out).not.toContain('tail');
      // Code surrounding the raw string is preserved.
      expect(out).toContain('x = r"');
      expect(out).toContain('+');
      // The trailing close quote of "tail" survives.
      expect(out.endsWith('"')).toBe(true);
    });

    it(String.raw`r'\'' — backslash-quote does not terminate (single-quoted)`, () => {
      // Source: x = r'\'' + 'tail'
      const src = String.raw`x = r'\'' + 'tail'`;
      const out = stripStrings(src);
      expect(out.length).toBe(src.length);
      expect(out).not.toContain('tail');
      expect(out).toContain("x = r'");
      expect(out).toContain('+');
      expect(out.endsWith("'")).toBe(true);
    });

    it(String.raw`r"\\" — backslash-backslash: \ is ordinary, two \s are two chars`, () => {
      // Source: x = r"\\" + "tail"
      // In raw mode, `\\` is just two ordinary backslashes; the literal
      // closes at the very next " after them.
      const src = String.raw`x = r"\\" + "tail"`;
      const out = stripStrings(src);
      expect(out.length).toBe(src.length);
      expect(out).not.toContain('tail');
      expect(out).toContain('x = r"');
      expect(out).toContain('+');
      // The two backslashes are inside the (stripped) string region;
      // preserved as whitespace by applyRegions.
      expect(out.endsWith('"')).toBe(true);
    });

    it(
      String.raw`r"\n" — backslash-n in raw string is ordinary text, no escape interpretation`,
      () => {
        // Source: x = r"\n" + "tail"
        // In raw mode, `\n` is just two ordinary chars (backslash and n);
        // the literal is closed by the very next ".
        const src = String.raw`x = r"\n" + "tail"`;
        const out = stripStrings(src);
        expect(out.length).toBe(src.length);
        expect(out).not.toContain('tail');
        // 'n' inside the raw string body is stripped (replaced with
        // whitespace by applyRegions). The standalone 'n' character
        // should not appear in plain code positions.
        expect(out).toContain('x = r"');
        expect(out.endsWith('"')).toBe(true);
      },
    );

    it(String.raw`rb"\"" — backslash-quote rule applies to all raw-prefix combos (rb)`, () => {
      const src = String.raw`x = rb"\"" + "tail"`;
      const out = stripStrings(src);
      expect(out.length).toBe(src.length);
      expect(out).not.toContain('tail');
      expect(out).toContain('x = rb"');
      expect(out.endsWith('"')).toBe(true);
    });

    it('triple-raw r"""...""" with backslash-quote inside body', () => {
      // Source: x = r"""\"""" + "tail"
      //                 ^^   ^^^
      //                 escaped quote, then closing triple, then "tail"
      // Without the fix, the scanner would handle `\` as ordinary,
      // see the next `"""` (which is actually `\"""` as the escape
      // skip), and close prematurely — corrupting the rest of the pass.
      const src = String.raw`x = r"""\"""" + "tail"`;
      const out = stripStrings(src);
      expect(out.length).toBe(src.length);
      expect(out).not.toContain('tail');
      expect(out).toContain('x = r"""');
      expect(out).toContain('+');
      expect(out.endsWith('"')).toBe(true);
    });
  });

  describe('disambiguation: empty triple-string vs paired empty strings', () => {
    it('"""""" — six quotes form one empty triple-quoted string', () => {
      // x = """""" — must be ONE empty triple, not three empty pairs.
      // After stripping, surrounding code remains and length is preserved.
      const src = 'x = """"""';
      const out = stripStrings(src);
      expect(out.length).toBe(src.length);
      expect(out).toContain('x =');
      // The opening and closing triple quotes are NOT part of the
      // stripped region (only the content between them is). Since
      // content is empty, output equals input.
      expect(out).toBe(src);
    });

    it("'''''' — six single quotes form one empty triple-quoted string", () => {
      const src = "x = ''''''";
      const out = stripStrings(src);
      expect(out.length).toBe(src.length);
      expect(out).toBe(src);
    });

    it('"" "" — paired empty strings separated by whitespace are two literals', () => {
      const src = 'x = "" ""';
      const out = stripStrings(src);
      expect(out.length).toBe(src.length);
      // Both empty strings have nothing to strip; output equals input.
      expect(out).toBe(src);
    });
  });
});

describe('python stripComments', () => {
  it('replaces line comments and keeps the code', () => {
    const src = 'x = 1  # comment';
    const out = stripComments(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('comment');
    expect(out).toContain('x = 1');
  });

  it('does NOT treat # inside a string literal as a comment', () => {
    const src = 'x = "hash inside #not a comment"';
    const out = stripComments(src);
    expect(out.length).toBe(src.length);
    // The string content (including the #) is stripped, but the code
    // surrounding it (the assignment) remains intact.
    expect(out).toContain('x =');
    expect(out).toContain('"');
    expect(out).not.toContain('not a comment');
    // Critically: the trailing `"` survives — proving we didn't run
    // off the end thinking the # started a comment.
    expect(out.endsWith('"')).toBe(true);
  });

  it('strips both strings and comments', () => {
    const src = '# header\nx = "secret"';
    const out = stripComments(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('header');
    expect(out).not.toContain('secret');
  });

  it('preserves newlines when stripping multi-line triple strings', () => {
    const src = 'x = """one\ntwo\nthree"""\n# trailing';
    const out = stripComments(src);
    expect(out.length).toBe(src.length);
    expect(out.split('\n').length).toBe(src.split('\n').length);
    expect(out).not.toContain('one');
    expect(out).not.toContain('trailing');
  });
});
