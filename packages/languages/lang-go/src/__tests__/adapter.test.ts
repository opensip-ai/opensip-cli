import { describe, expect, it } from 'vitest';

import { goAdapter } from '../adapter.js';
import { stripComments, stripStrings } from '../strip.js';

describe('goAdapter', () => {
  it('declares the expected identity and extension', () => {
    expect(goAdapter.id).toBe('go');
    expect(goAdapter.fileExtensions).toContain('.go');
  });

  it('parse() returns a real tree-sitter tree + source', () => {
    const src = 'package main\n\nfunc main() {}\n';
    const tree = goAdapter.parse(src, 'foo.go');
    expect(tree).not.toBeNull();
    expect(tree?.source).toBe(src);
    expect(tree?.tree.rootNode.type).toBe('source_file');
  });
});

describe('go stripStrings', () => {
  it('replaces regular string content but preserves length', () => {
    const src = 's := "hello world"';
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('hello');
    expect(out).toContain('s :=');
    expect(out).toContain('"');
  });

  it('strips raw multi-line string body and preserves newlines', () => {
    const src = 's := `\nline1\nline2\n`';
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('line1');
    expect(out).not.toContain('line2');
    // Newlines must survive so line numbers stay stable
    expect(out.split('\n').length).toBe(src.split('\n').length);
    expect(out).toContain('s :=');
    expect(out).toContain('`');
  });

  it('preserves rune literals (single chars are code, not strings)', () => {
    const src = "c := 'x'";
    const out = stripStrings(src);
    expect(out).toBe(src);
  });

  it('strips entire content of regular string with escape', () => {
    const src = String.raw`s := "tab\there"`;
    const out = stripStrings(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('tab');
    expect(out).not.toContain('here');
    expect(out).toContain('s :=');
    expect(out).toContain('"');
  });
});

describe('go stripComments', () => {
  it('replaces line comments', () => {
    const src = 'x := 1 // comment';
    const out = stripComments(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('comment');
    expect(out).toContain('x := 1');
  });

  it('replaces block comments', () => {
    const src = 'x := /* hi */ 2';
    const out = stripComments(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('hi');
    expect(out).toContain('x :=');
    expect(out).toContain('2');
  });

  it('strips string body when // appears inside a string', () => {
    const src = 's := "// not a comment"';
    const out = stripComments(src);
    expect(out.length).toBe(src.length);
    expect(out).not.toContain('not a comment');
    // Outside the string, structure remains intact
    expect(out).toContain('s :=');
    expect(out).toContain('"');
  });

  it('also strips strings', () => {
    const src = '// hi\ns := "secret"';
    const out = stripComments(src);
    expect(out).not.toContain('secret');
    expect(out).not.toContain('hi');
  });
});

// Edge-case regression tests (Wave 1 P0 — audit findings F4/F5).
// These pin behavior that the current scanner already handles correctly so
// future refactors of strip.ts cannot silently regress them.
describe('go strip edge cases', () => {
  describe('// inside raw string', () => {
    it('does not treat // inside backticks as a comment, but strips trailing line comment', () => {
      const src = 'x := `// not a comment`\ny := 1 // real comment';
      const out = stripComments(src);
      expect(out.length).toBe(src.length);
      // Raw-string body is replaced by whitespace, including the // sequence
      expect(out).not.toContain('// not a comment');
      expect(out).not.toContain('not a comment');
      // The trailing real comment text is also stripped
      expect(out).not.toContain('real comment');
      // Code structure outside the string/comment is preserved
      expect(out).toContain('x :=');
      expect(out).toContain('y := 1');
      expect(out).toContain('`');
    });

    it('stripStrings alone does not interpret // inside raw string as a comment', () => {
      const src = 'x := `// not a comment`';
      const out = stripStrings(src);
      expect(out.length).toBe(src.length);
      expect(out).not.toContain('not a comment');
      expect(out).toContain('x :=');
      expect(out).toContain('`');
    });
  });

  describe('unterminated literals (graceful handling)', () => {
    it('does not crash on an unterminated raw string and preserves length', () => {
      const src = 'x := `unfinished';
      const out = stripStrings(src);
      expect(out.length).toBe(src.length);
      expect(out).not.toContain('unfinished');
      expect(out).toContain('x :=');
      expect(out).toContain('`');
    });

    it('does not crash on an unterminated block comment and preserves length', () => {
      const src = 'x := 1 /* never closed';
      const out = stripComments(src);
      expect(out.length).toBe(src.length);
      expect(out).not.toContain('never closed');
      expect(out).toContain('x := 1');
    });

    it('does not crash on an unterminated interpreted string and preserves length', () => {
      const src = 's := "unfinished';
      const out = stripStrings(src);
      expect(out.length).toBe(src.length);
      expect(out).toContain('s :=');
    });
  });

  describe('dispatch-order regressions (MISSED-1)', () => {
    it('block comment with embedded `*/` does not nest — first `*/` terminates', () => {
      // Go block comments are non-nesting (unlike Rust). Source:
      //   /* a */ b */
      // The first `*/` closes the comment; ` b */` is plain code.
      const src = '/* a */ b */';
      const out = stripComments(src);
      expect(out.length).toBe(src.length);
      // The text inside the comment is gone.
      expect(out).not.toContain('a');
      // The trailing `b */` survives as code.
      expect(out).toContain('b');
      expect(out).toContain('*/');
    });

    it('rune literal inside a raw string is treated as raw content, not as a rune', () => {
      // Source: x := `'a'`
      // The raw-string branch must win over the rune branch — the `'a'`
      // must NOT be interpreted as a rune literal interrupting the
      // raw-string scan.
      const src = "x := `'a'`";
      const out = stripStrings(src);
      expect(out.length).toBe(src.length);
      // The body is stripped (raw-string region).
      expect(out).not.toContain("'a'");
      // The opening/closing backticks survive.
      expect(out).toContain('`');
      expect(out).toContain('x :=');
    });
  });

  describe('rune literals — pin current permissive behavior (audit F4)', () => {
    // The audit notes the rune scanner is permissive: it accepts variable
    // escape lengths rather than enforcing Go's exact rules (\uXXXX = 4 hex,
    // \UXXXXXXXX = 8 hex). Today this is a non-issue because rune literals
    // are preserved as code (not stripped) and surrounding code keeps the
    // scanner aligned. These tests pin the current behavior so any future
    // tightening of the scanner becomes a visible change.

    it('preserves a single-char rune literal', () => {
      const src = "r := 'a'";
      const out = stripStrings(src);
      expect(out).toBe(src);
    });

    it(String.raw`preserves a rune literal with a simple escape ('\n')`, () => {
      const src = String.raw`r := '\n'`;
      const out = stripStrings(src);
      expect(out).toBe(src);
    });

    it(String.raw`preserves a rune literal with a 4-hex Unicode escape ('\u0041')`, () => {
      const src = String.raw`r := 'A'`;
      const out = stripStrings(src);
      expect(out).toBe(src);
    });

    it(
      String.raw`preserves a rune literal with an 8-hex long Unicode escape ('\U0001F600')`,
      () => {
        // F4 case: scanner is permissive about escape length; pin that the
        // long-Unicode form still passes through unchanged today.
        const src = String.raw`r := '\U0001F600'`;
        const out = stripStrings(src);
        expect(out).toBe(src);
      },
    );

    it('preserves multiple rune literals in sequence alongside strings', () => {
      const src = String.raw`a := 'a'; b := '\n'; c := 'A'; s := "hello"`;
      const out = stripStrings(src);
      expect(out.length).toBe(src.length);
      // Rune literals survive verbatim
      expect(out).toContain("'a'");
      expect(out).toContain(String.raw`'\n'`);
      expect(out).toContain(String.raw`'A'`);
      // The interpreted string body is stripped
      expect(out).not.toContain('hello');
      expect(out).toContain('"');
    });
  });

  describe('length preservation — explicit assert across edge cases', () => {
    const cases: { name: string; src: string }[] = [
      { name: '// inside raw string', src: 'x := `// not a comment`\ny := 1 // real' },
      { name: 'unterminated raw string', src: 'x := `unfinished' },
      { name: 'unterminated block comment', src: 'x := 1 /* never closed' },
      { name: 'unterminated interpreted string', src: 's := "unfinished' },
      { name: 'rune single char', src: "r := 'a'" },
      { name: 'rune simple escape', src: String.raw`r := '\n'` },
      { name: String.raw`rune \u escape`, src: String.raw`r := 'A'` },
      { name: String.raw`rune \U escape`, src: String.raw`r := '\U0001F600'` },
      {
        name: 'mixed runes and string',
        src: String.raw`a := 'a'; b := '\n'; c := 'A'; s := "hello"`,
      },
    ];

    for (const { name, src } of cases) {
      it(`stripStrings preserves length: ${name}`, () => {
        expect(stripStrings(src).length).toBe(src.length);
      });
      it(`stripComments preserves length: ${name}`, () => {
        expect(stripComments(src).length).toBe(src.length);
      });
    }
  });
});
