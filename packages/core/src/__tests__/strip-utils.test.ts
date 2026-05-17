import { describe, expect, it } from 'vitest';

import {
  applyRegions,
  buildLineStarts,
  scanRegularString,
  type Region,
} from '../languages/strip-utils.js';

describe('scanRegularString', () => {
  it('returns the closing quote position for a simple terminated string', () => {
    //              0123456789
    const src = '"hello"';
    const result = scanRegularString(src, 0);
    expect(result.contentEnd).toBe(6); // closing quote at index 6
    expect(result.next).toBe(7); // resume after the quote
    expect(src[result.contentEnd]).toBe('"');
  });

  it('returns an empty string range when the quotes are adjacent', () => {
    const src = '""';
    const result = scanRegularString(src, 0);
    expect(result.contentEnd).toBe(1);
    expect(result.next).toBe(2);
  });

  it('honors backslash escapes for escaped quotes', () => {
    // The \" should not terminate the string.
    const src = String.raw`"a\"b"`;
    //              0 1 2 3 4 5
    const result = scanRegularString(src, 0);
    // The real closing quote is at index 5.
    expect(result.contentEnd).toBe(5);
    expect(result.next).toBe(6);
  });

  it('honors backslash escapes for escaped backslashes', () => {
    // "\\" — the second \ is escaped, the closing quote is at index 3.
    const src = String.raw`"\\"`;
    const result = scanRegularString(src, 0);
    expect(result.contentEnd).toBe(3);
    expect(result.next).toBe(4);
  });

  it('skips arbitrary backslash escape sequences as a 2-char unit', () => {
    // "\n\t\r" as literal escape sequences in the source — closing quote at index 7.
    const src = String.raw`"\n\t\r"`;
    const result = scanRegularString(src, 0);
    expect(result.contentEnd).toBe(7);
    expect(result.next).toBe(8);
  });

  it('stops at an unescaped newline (unterminated regular string)', () => {
    // Source: "abc\n"def — the regular-string scanner should stop at the \n.
    const src = '"abc\ndef"';
    //              0 1 2 3  4 5 6 7 8
    const result = scanRegularString(src, 0);
    expect(src[result.contentEnd]).toBe('\n');
    expect(result.contentEnd).toBe(4);
    // Caller resumes AT the newline (not past it) — language scanner decides
    // how to recover.
    expect(result.next).toBe(4);
  });

  it('returns EOF position when the string is unterminated by EOF', () => {
    const src = '"abc';
    const result = scanRegularString(src, 0);
    expect(result.contentEnd).toBe(src.length);
    expect(result.next).toBe(src.length);
  });

  it('returns EOF position when a trailing backslash escape walks past the end', () => {
    // "ab\ — backslash consumes 2 chars and pushes i past the end.
    const src = '"ab\\';
    const result = scanRegularString(src, 0);
    expect(result.contentEnd).toBe(src.length);
    expect(result.next).toBe(src.length);
  });

  it('scans a string that starts mid-source', () => {
    // foo = "bar"
    //  0123456789
    const src = 'foo = "bar"';
    const openQuote = src.indexOf('"');
    expect(openQuote).toBe(6);
    const result = scanRegularString(src, openQuote);
    expect(result.contentEnd).toBe(10);
    expect(result.next).toBe(11);
  });

  it('handles empty source after the open quote position (EOF immediately)', () => {
    // openQuotePos === len - 1, so i starts at len and the loop never runs.
    const src = '"';
    const result = scanRegularString(src, 0);
    expect(result.contentEnd).toBe(1);
    expect(result.next).toBe(1);
  });
});

describe('applyRegions', () => {
  it('returns the source unchanged when the regions list is empty', () => {
    const src = 'hello world';
    expect(applyRegions(src, [])).toBe(src);
  });

  it('returns the same instance reference when there are no regions', () => {
    // Fast-path: empty regions returns src directly without splitting.
    const src = 'hello world';
    expect(applyRegions(src, [])).toBe(src);
  });

  it('replaces a single region with spaces', () => {
    const src = 'hello world';
    //              0123456789
    const regions: Region[] = [{ start: 6, end: 11 }];
    expect(applyRegions(src, regions)).toBe('hello      ');
  });

  it('preserves newlines inside regions so offsets stay valid', () => {
    const src = 'a\nbc\nd';
    //              0 1 2 3 4 5
    // Replace the entire source — newlines should remain.
    const regions: Region[] = [{ start: 0, end: src.length }];
    expect(applyRegions(src, regions)).toBe(' \n  \n ');
  });

  it('preserves length exactly so AST offsets remain valid', () => {
    const src = '/* comment */ code';
    const regions: Region[] = [{ start: 0, end: 13 }];
    const out = applyRegions(src, regions);
    expect(out.length).toBe(src.length);
    expect(out).toBe('              code');
  });

  it('applies multiple non-overlapping regions', () => {
    const src = 'abcdefghij';
    //              0123456789
    const regions: Region[] = [
      { start: 1, end: 3 },
      { start: 6, end: 9 },
    ];
    expect(applyRegions(src, regions)).toBe('a  def   j');
  });

  it('handles overlapping regions idempotently (re-blanks already blank chars)', () => {
    const src = 'abcdef';
    const regions: Region[] = [
      { start: 0, end: 4 },
      { start: 2, end: 6 },
    ];
    expect(applyRegions(src, regions)).toBe('      ');
  });

  it('handles a zero-length region as a no-op', () => {
    const src = 'abcdef';
    const regions: Region[] = [{ start: 3, end: 3 }];
    expect(applyRegions(src, regions)).toBe('abcdef');
  });

  it('preserves UTF-16 indexing for surrogate pairs (emoji)', () => {
    // The rocket emoji is 2 UTF-16 code units wide. The function uses
    // .split('') to keep UTF-16 unit indexing intact.
    const src = 'a🚀b'; // 'a' + rocket + 'b' — length 4 in UTF-16 units.
    expect(src.length).toBe(4);
    // Replace the 'b' (index 3) only — emoji untouched.
    const out = applyRegions(src, [{ start: 3, end: 4 }]);
    expect(out.length).toBe(4);
    expect(out).toBe('a🚀 ');
  });
});

describe('buildLineStarts', () => {
  it('returns [0] for an empty string', () => {
    expect(buildLineStarts('')).toEqual([0]);
  });

  it('returns [0] for a single-line string with no newline', () => {
    expect(buildLineStarts('hello')).toEqual([0]);
  });

  it('records the offset after each newline', () => {
    // "a\nbc\nd"
    //  0 1 2 3 4 5
    // Line 0 starts at 0, line 1 starts after the first \n (index 2),
    // line 2 starts after the second \n (index 5).
    expect(buildLineStarts('a\nbc\nd')).toEqual([0, 2, 5]);
  });

  it('records a line start past EOF when the source ends with a newline', () => {
    // "a\n" — there is a "line 1" that starts at index 2 (== src.length).
    expect(buildLineStarts('a\n')).toEqual([0, 2]);
  });

  it('handles consecutive newlines (blank lines)', () => {
    // "\n\n" — three lines: 0, 1, 2 starting at 0, 1, 2.
    expect(buildLineStarts('\n\n')).toEqual([0, 1, 2]);
  });

  it('treats CR alone as part of the line (only LF delimits)', () => {
    // "\r\n" — CRLF: only \n bumps a line start. The \n is at index 1,
    // so the next line starts at index 2.
    expect(buildLineStarts('a\r\nb')).toEqual([0, 3]);
  });

  it('keeps UTF-16 offsets for surrogate pairs', () => {
    // Rocket emoji takes two UTF-16 code units.
    const src = '🚀\nx';
    // The \n is at index 2; line 1 starts at index 3.
    expect(src.length).toBe(4);
    expect(buildLineStarts(src)).toEqual([0, 3]);
  });

  it('returns offsets that index back into the source for each line', () => {
    const src = 'first\nsecond\nthird';
    const starts = buildLineStarts(src);
    expect(starts).toEqual([0, 6, 13]);
    expect(src.slice(starts[0], starts[1] - 1)).toBe('first');
    expect(src.slice(starts[1], starts[2] - 1)).toBe('second');
    expect(src.slice(starts[2])).toBe('third');
  });
});
