import { describe, expect, it } from 'vitest';

import { parseJsonLines } from '../json-lines.js';

describe('parseJsonLines', () => {
  it('parses one JSON value per non-empty line, tracking 1-based line numbers', () => {
    const result = parseJsonLines('{"a":1}\n{"b":2}\n');
    expect(result.values).toEqual([
      { line: 1, value: { a: 1 } },
      { line: 2, value: { b: 2 } },
    ]);
    expect(result.errors).toEqual([]);
  });

  it('handles CRLF line endings and skips blank lines', () => {
    const result = parseJsonLines('{"a":1}\r\n\r\n{"b":2}');
    expect(result.values.map((v) => v.value)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('reports a parse error (with a truncated preview) for a malformed JSON line', () => {
    const result = parseJsonLines('{"a":1}\n{bad json here');
    expect(result.values).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ line: 2 });
    expect(result.errors[0]?.preview).toContain('{bad json');
  });

  it('truncates the error preview to maxPreviewChars with an ellipsis', () => {
    const long = `{${'x'.repeat(500)}`;
    const result = parseJsonLines(long, { maxPreviewChars: 20 });
    expect(result.errors[0]?.preview.endsWith('...')).toBe(true);
    expect(result.errors[0]?.preview.length).toBeLessThanOrEqual(23);
  });

  it('with tolerateNonJson, silently drops non-JSON lines that do not start with { or [', () => {
    const result = parseJsonLines('progress: scanning...\n{"finding":1}', {
      tolerateNonJson: true,
    });
    expect(result.values.map((v) => v.value)).toEqual([{ finding: 1 }]);
    expect(result.errors).toEqual([]);
  });

  it('still reports a malformed line that LOOKS like JSON even under tolerateNonJson', () => {
    const result = parseJsonLines('{"broken', { tolerateNonJson: true });
    expect(result.errors).toHaveLength(1);
  });

  it('returns empty results for empty input', () => {
    expect(parseJsonLines('')).toEqual({ values: [], errors: [] });
  });
});
