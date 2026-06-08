/**
 * Unit tests for the shared session-payload decoder (the inverse of each tool's
 * `build*SessionPayload`). Covers every per-tool option toggle
 * (requireFilePath / requireViolationCount / allowMetadata) and every
 * validation branch, plus the directly-exported field coercers.
 */

import { describe, expect, it } from 'vitest';

import {
  booleanField,
  decodeSessionPayload,
  decodeSummary,
  numberField,
  stringField,
} from '../session-payload-decode.js';

const SUMMARY = { total: 2, passed: 1, failed: 1, errors: 1, warnings: 0 };

function fitCheck(over: Record<string, unknown> = {}) {
  return {
    checkSlug: 'a',
    passed: false,
    durationMs: 5,
    findings: [{ ruleId: 'r', message: 'm', severity: 'error' }],
    ...over,
  };
}

describe('decodeSessionPayload — fit-style options (all relaxed)', () => {
  it('decodes summary, checks, and an optional-field-free finding', () => {
    const decoded = decodeSessionPayload(
      { summary: SUMMARY, checks: [fitCheck()] },
      { tool: 'fit' },
    );
    expect(decoded.summary).toEqual(SUMMARY);
    expect(decoded.checks).toHaveLength(1);
    const check = decoded.checks[0];
    expect(check.violationCount).toBeUndefined();
    const finding = check.findings[0];
    expect(finding).toEqual({ ruleId: 'r', message: 'm', severity: 'error' });
    expect(finding.filePath).toBeUndefined();
  });

  it('keeps a numeric violationCount and all optional finding fields', () => {
    const decoded = decodeSessionPayload(
      {
        summary: SUMMARY,
        checks: [
          fitCheck({
            violationCount: 3,
            findings: [
              { ruleId: 'r', message: 'm', severity: 'warning', filePath: 'x.ts', line: 4, column: 2, suggestion: 'fix' },
            ],
          }),
        ],
      },
      { tool: 'fit' },
    );
    expect(decoded.checks[0].violationCount).toBe(3);
    expect(decoded.checks[0].findings[0]).toEqual({
      ruleId: 'r', message: 'm', severity: 'warning', filePath: 'x.ts', line: 4, column: 2, suggestion: 'fix',
    });
  });

  it('ignores a non-numeric violationCount when not required', () => {
    const decoded = decodeSessionPayload(
      { summary: SUMMARY, checks: [fitCheck({ violationCount: 'nope' })] },
      { tool: 'fit' },
    );
    expect(decoded.checks[0].violationCount).toBeUndefined();
  });

  it('drops metadata entirely when allowMetadata is off', () => {
    const decoded = decodeSessionPayload(
      { summary: SUMMARY, checks: [fitCheck({ findings: [{ ruleId: 'r', message: 'm', severity: 'error', metadata: { a: 1 } }] })] },
      { tool: 'fit' },
    );
    expect(decoded.checks[0].findings[0].metadata).toBeUndefined();
  });
});

describe('decodeSessionPayload — graph-style options (all strict)', () => {
  const graphOpts = { tool: 'graph', requireFilePath: true, requireViolationCount: true, allowMetadata: true } as const;

  it('decodes required filePath/violationCount and a scalar metadata bag', () => {
    const decoded = decodeSessionPayload(
      {
        summary: SUMMARY,
        checks: [
          {
            checkSlug: 'g', passed: false, violationCount: 2, durationMs: 0,
            findings: [{ ruleId: 'r', message: 'm', severity: 'error', filePath: 'a.ts', metadata: { fanIn: 9, name: 'x', on: true, nested: { drop: 1 } } }],
          },
        ],
      },
      graphOpts,
    );
    expect(decoded.checks[0].violationCount).toBe(2);
    expect(decoded.checks[0].findings[0].filePath).toBe('a.ts');
    expect(decoded.checks[0].findings[0].metadata).toEqual({ fanIn: 9, name: 'x', on: true });
  });

  it('returns undefined metadata when the bag has no scalar entries', () => {
    const decoded = decodeSessionPayload(
      { summary: SUMMARY, checks: [{ checkSlug: 'g', passed: true, violationCount: 0, durationMs: 0, findings: [{ ruleId: 'r', message: 'm', severity: 'error', filePath: 'a.ts', metadata: { nested: {} } }] }] },
      graphOpts,
    );
    expect(decoded.checks[0].findings[0].metadata).toBeUndefined();
  });

  it('treats null/non-object metadata as undefined', () => {
    const decoded = decodeSessionPayload(
      { summary: SUMMARY, checks: [{ checkSlug: 'g', passed: true, violationCount: 0, durationMs: 0, findings: [{ ruleId: 'r', message: 'm', severity: 'error', filePath: 'a.ts', metadata: null }] }] },
      graphOpts,
    );
    expect(decoded.checks[0].findings[0].metadata).toBeUndefined();
  });

  it('throws when a required filePath is missing', () => {
    expect(() =>
      decodeSessionPayload(
        { summary: SUMMARY, checks: [{ checkSlug: 'g', passed: true, violationCount: 0, durationMs: 0, findings: [{ ruleId: 'r', message: 'm', severity: 'error' }] }] },
        graphOpts,
      ),
    ).toThrow(/graph session finding\.filePath must be a string/);
  });

  it('throws when a required violationCount is missing', () => {
    expect(() =>
      decodeSessionPayload(
        { summary: SUMMARY, checks: [{ checkSlug: 'g', passed: true, durationMs: 0, findings: [] }] },
        graphOpts,
      ),
    ).toThrow(/graph session check\.violationCount must be a number/);
  });
});

describe('decodeSessionPayload — validation errors', () => {
  const cases: { name: string; payload: unknown; message: RegExp }[] = [
    { name: 'null payload', payload: null, message: /fit session has no replay payload/ },
    { name: 'non-object payload', payload: 'nope', message: /no replay payload/ },
    { name: 'missing summary', payload: { checks: [] }, message: /summary is missing/ },
    { name: 'null summary', payload: { summary: null, checks: [] }, message: /summary is missing/ },
    { name: 'non-number summary field', payload: { summary: { ...SUMMARY, total: 'x' }, checks: [] }, message: /total must be a number/ },
    { name: 'missing checks[]', payload: { summary: SUMMARY }, message: /missing checks\[\]/ },
    { name: 'null check row', payload: { summary: SUMMARY, checks: [null] }, message: /check row is invalid/ },
    { name: 'non-string checkSlug', payload: { summary: SUMMARY, checks: [{ checkSlug: 1, passed: true, durationMs: 0, findings: [] }] }, message: /checkSlug must be a string/ },
    { name: 'non-boolean passed', payload: { summary: SUMMARY, checks: [{ checkSlug: 'a', passed: 'yes', durationMs: 0, findings: [] }] }, message: /passed must be a boolean/ },
    { name: 'check missing findings[]', payload: { summary: SUMMARY, checks: [{ checkSlug: 'a', passed: true, durationMs: 0 }] }, message: /missing findings\[\]/ },
    { name: 'null finding row', payload: { summary: SUMMARY, checks: [{ checkSlug: 'a', passed: true, durationMs: 0, findings: [null] }] }, message: /finding is invalid/ },
    { name: 'invalid severity', payload: { summary: SUMMARY, checks: [{ checkSlug: 'a', passed: true, durationMs: 0, findings: [{ ruleId: 'r', message: 'm', severity: 'info' }] }] }, message: /invalid severity/ },
    { name: 'non-string ruleId', payload: { summary: SUMMARY, checks: [{ checkSlug: 'a', passed: true, durationMs: 0, findings: [{ ruleId: 1, message: 'm', severity: 'error' }] }] }, message: /ruleId must be a string/ },
  ];

  for (const { name, payload, message } of cases) {
    it(`throws on ${name}`, () => {
      expect(() => decodeSessionPayload(payload, { tool: 'fit' })).toThrow(message);
    });
  }
});

describe('exported field coercers', () => {
  it('numberField returns numbers and rejects non-numbers', () => {
    expect(numberField({ n: 3 }, 'n', 'L')).toBe(3);
    expect(() => numberField({ n: 'x' }, 'n', 'L')).toThrow(/L\.n must be a number/);
  });
  it('stringField returns strings and rejects non-strings', () => {
    expect(stringField({ s: 'hi' }, 's', 'L')).toBe('hi');
    expect(() => stringField({ s: 2 }, 's', 'L')).toThrow(/L\.s must be a string/);
  });
  it('booleanField returns booleans and rejects non-booleans', () => {
    expect(booleanField({ b: true }, 'b', 'L')).toBe(true);
    expect(() => booleanField({ b: 1 }, 'b', 'L')).toThrow(/L\.b must be a boolean/);
  });
  it('decodeSummary rejects a missing block', () => {
    expect(() => decodeSummary(undefined, 'sum')).toThrow(/sum is missing/);
    expect(decodeSummary(SUMMARY, 'sum')).toEqual(SUMMARY);
  });
});
