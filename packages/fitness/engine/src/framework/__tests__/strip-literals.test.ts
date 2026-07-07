import { describe, expect, it } from 'vitest';

import {
  isInsideStringLiteral,
  stripStringLiterals,
  stripStringLiteralsPreservingPositions,
  stripStringsAndComments,
  stripStringsAndCommentsPreservingPositions,
} from '../strip-literals.js';

describe('stripStringLiterals', () => {
  it('empties single-quoted strings', () => {
    expect(stripStringLiterals(`const a = 'hi'`)).toBe(`const a = ''`);
  });

  it('empties double-quoted strings', () => {
    expect(stripStringLiterals(`const a = "hi"`)).toBe(`const a = ""`);
  });

  it('empties template literals', () => {
    expect(stripStringLiterals('const a = `hi`')).toBe('const a = ``');
  });

  it('preserves escaped quotes', () => {
    expect(stripStringLiterals(String.raw`const a = 'it\'s'`)).toBe(`const a = ''`);
  });
});

describe('stripStringLiteralsPreservingPositions', () => {
  it('blanks interiors but preserves length, delimiters, and outside code', () => {
    const src = `const a = "hi", b = "yo"`;
    const out = stripStringLiteralsPreservingPositions(src);
    expect(out.length).toBe(src.length);
    expect(out).toBe(`const a = "  ", b = "  "`);
  });

  it('keeps a match index aligned to the ORIGINAL column when a literal precedes it', () => {
    // The whole point of the variant: `stripStringLiterals` collapses the leading
    // literal and shifts `===` left; the preserving variant does not.
    const src = `req.headers["x-api-key"] === API_KEY`;
    const out = stripStringLiteralsPreservingPositions(src);
    expect(out.length).toBe(src.length);
    expect(out.indexOf('===')).toBe(src.indexOf('===')); // column preserved
  });

  it('preserves interior newlines in a multi-line template literal', () => {
    const src = 'a = `x\ny` + b';
    const out = stripStringLiteralsPreservingPositions(src);
    expect(out.length).toBe(src.length);
    expect(out.split('\n').length).toBe(src.split('\n').length);
    expect(out).not.toContain('x');
  });

  it('handles escaped quotes without shifting length', () => {
    const src = String.raw`const a = 'it\'s' + z`;
    const out = stripStringLiteralsPreservingPositions(src);
    expect(out.length).toBe(src.length);
    expect(out.indexOf('+ z')).toBe(src.indexOf('+ z'));
  });
});

describe('stripStringsAndComments', () => {
  it('strips strings AND single-line comments', () => {
    const out = stripStringsAndComments(`const a = "hi"; // comment\nconst b = 1;`);
    expect(out).not.toContain('hi');
    expect(out).not.toContain('comment');
  });

  it('keeps code outside strings/comments intact', () => {
    const out = stripStringsAndComments(`const x = 1;`);
    expect(out).toBe(`const x = 1;`);
  });
});

describe('isInsideStringLiteral', () => {
  it('returns true for a position inside a single-quoted string', () => {
    expect(isInsideStringLiteral(`const x = 'hello'`, 12)).toBe(true);
  });

  it('returns true for a position inside a double-quoted string', () => {
    expect(isInsideStringLiteral(`const x = "hello"`, 12)).toBe(true);
  });

  it('returns true for a position inside a template literal', () => {
    expect(isInsideStringLiteral('const x = `hello`', 12)).toBe(true);
  });

  it('returns false for a position outside any string', () => {
    expect(isInsideStringLiteral(`const x = "h"; foo()`, 18)).toBe(false);
  });

  it('handles escaped quotes correctly', () => {
    // Position 14 is inside the closed string, so still inside the next
    // unescaped quote? Actually after the closing quote, so outside.
    expect(isInsideStringLiteral(String.raw`const x = 'it\'s'`, 14)).toBe(true);
  });
});

describe('stripStringsAndCommentsPreservingPositions', () => {
  it('replaces string content with spaces while preserving newlines', () => {
    const input = `const a = "hi"\nconst b = 1`;
    const output = stripStringsAndCommentsPreservingPositions(input);
    expect(output.length).toBe(input.length);
    expect(output).toContain('\n');
    expect(output).not.toContain('hi');
  });

  it('blanks out single-line comments to end of line', () => {
    const input = `const x = 1; // comment\nconst y = 2;`;
    const output = stripStringsAndCommentsPreservingPositions(input);
    expect(output.length).toBe(input.length);
    expect(output).not.toContain('comment');
    expect(output).toContain('const x = 1;');
  });

  it('blanks out block comments preserving line breaks', () => {
    const input = `const a = 1;\n/* multi\n   line\n*/\nconst b = 2;`;
    const output = stripStringsAndCommentsPreservingPositions(input);
    expect(output.length).toBe(input.length);
    expect(output).not.toContain('multi');
    expect(output).not.toContain('line');
  });

  it('handles escaped characters inside strings', () => {
    const input = String.raw`const a = "it\"s";`;
    const output = stripStringsAndCommentsPreservingPositions(input);
    expect(output.length).toBe(input.length);
    expect(output).not.toContain('it');
  });

  it('preserves character positions outside strings/comments', () => {
    const input = `const x = "y"; foo();`;
    const output = stripStringsAndCommentsPreservingPositions(input);
    expect(output.length).toBe(input.length);
    expect(output).toContain('foo()');
    // The "x" identifier should be at the same position
    expect(output[6]).toBe('x');
  });

  it('handles empty content', () => {
    expect(stripStringsAndCommentsPreservingPositions('')).toBe('');
  });
});
