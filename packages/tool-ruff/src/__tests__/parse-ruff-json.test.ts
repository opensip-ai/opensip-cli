import { describe, expect, it } from 'vitest';

import { parseRuffJson } from '../parse-ruff-json.js';

import type { AdapterRunContext, ParsedScannerOutput } from '@opensip-cli/external-tool-adapter';

const CTX = {
  projectRoot: '/proj',
  tool: 'ruff',
} as unknown as AdapterRunContext;

/** Build the `ParsedScannerOutput` the run loop hands a JSON-kind parser. */
function output(raw: string): ParsedScannerOutput {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    json = undefined;
  }
  return { kind: 'json', raw, ...(json === undefined ? {} : { json }) };
}

describe('parseRuffJson', () => {
  it('normalizes a diagnostic array into signals (code → ruleId, location → line/col)', () => {
    const raw = JSON.stringify([
      {
        code: 'F401',
        filename: 'src/app.py',
        message: '`os` imported but unused',
        location: { row: 1, column: 8 },
        url: 'https://docs.astral.sh/ruff/rules/unused-import',
      },
    ]);
    const signals = parseRuffJson(output(raw), CTX);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      ruleId: 'F401',
      message: '`os` imported but unused',
      filePath: 'src/app.py',
      line: 1,
      column: 8,
    });
  });

  it('defaults severity to medium (ruff emits no severity field)', () => {
    const raw = JSON.stringify([
      {
        code: 'E501',
        filename: 'a.py',
        message: 'Line too long',
        location: { row: 2, column: 89 },
      },
    ]);
    const [signal] = parseRuffJson(output(raw), CTX);
    expect(signal?.severity).toBe('medium');
    expect(signal?.metadata?.nativeSeverity).toBeNull();
  });

  it('returns no signals for a clean run (empty array)', () => {
    expect(parseRuffJson(output('[]'), CTX)).toEqual([]);
  });

  it('tolerates malformed / non-JSON output without throwing (zero signals)', () => {
    expect(parseRuffJson(output('not json at all'), CTX)).toEqual([]);
    expect(parseRuffJson(output('{"unexpected":"object"}'), CTX)).toEqual([]);
  });

  it('skips array entries that are not objects', () => {
    const raw = JSON.stringify([null, 5, 'x', { code: 'F401', filename: 'a.py', message: 'm' }]);
    expect(parseRuffJson(output(raw), CTX)).toHaveLength(1);
  });

  it('falls back to the rule id for a diagnostic with no message', () => {
    const raw = JSON.stringify([
      { code: 'B008', filename: 'a.py', location: { row: 1, column: 1 } },
    ]);
    const [signal] = parseRuffJson(output(raw), CTX);
    expect(signal?.message).toBe('B008');
  });
});
