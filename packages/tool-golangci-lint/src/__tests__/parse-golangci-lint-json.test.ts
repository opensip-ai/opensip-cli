import { describe, expect, it, vi } from 'vitest';

import { parseGolangciLintJson } from '../parse-golangci-lint-json.js';

import type { AdapterRunContext, ParsedScannerOutput } from '@opensip-cli/external-tool-adapter';

const CTX = {
  projectRoot: '/proj',
  tool: 'golangci-lint',
} as unknown as AdapterRunContext;

/** golangci-lint v2 streams a single JSON report object to stdout. */
function output(raw: string): ParsedScannerOutput {
  return { kind: 'stdout', raw };
}

/** The run loop can also hand a pre-parsed `json` for a JSON-kind output. */
function jsonOutput(raw: string): ParsedScannerOutput {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    json = undefined;
  }
  return { kind: 'json', raw, ...(json === undefined ? {} : { json }) };
}

const report = (issues: unknown[]): string => JSON.stringify({ Issues: issues, Report: {} });

describe('parseGolangciLintJson', () => {
  it('normalizes issues (FromLinter → ruleId, Pos → file/line/column, Text → message)', () => {
    const raw = report([
      {
        FromLinter: 'errcheck',
        Text: 'Error return value not checked',
        Severity: '',
        Pos: { Filename: 'main.go', Line: 10, Column: 2 },
      },
      {
        FromLinter: 'govet',
        Text: 'printf: bad format',
        Severity: '',
        Pos: { Filename: 'handler.go', Line: 22, Column: 5 },
      },
    ]);
    const signals = parseGolangciLintJson(output(raw), CTX);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({
      ruleId: 'errcheck',
      severity: 'medium',
      message: 'Error return value not checked',
      filePath: 'main.go',
      line: 10,
      column: 2,
    });
    expect(signals[1]).toMatchObject({
      ruleId: 'govet',
      message: 'printf: bad format',
      filePath: 'handler.go',
      line: 22,
      column: 5,
    });
  });

  it('reads a pre-parsed `json` document (kind: json) as well as raw text', () => {
    const raw = report([
      {
        FromLinter: 'errcheck',
        Text: 'm',
        Severity: '',
        Pos: { Filename: 'a.go', Line: 1, Column: 1 },
      },
    ]);
    expect(parseGolangciLintJson(jsonOutput(raw), CTX)).toHaveLength(1);
  });

  it('maps a native Severity label (warning → medium, error → high)', () => {
    const raw = report([
      {
        FromLinter: 'x',
        Text: 'm',
        Severity: 'error',
        Pos: { Filename: 'a.go', Line: 1, Column: 1 },
      },
    ]);
    const [signal] = parseGolangciLintJson(output(raw), CTX);
    expect(signal?.severity).toBe('high');
  });

  it('falls back to the linter name when an issue has no Text', () => {
    const raw = report([{ FromLinter: 'gofmt', Pos: { Filename: 'a.go', Line: 1, Column: 1 } }]);
    const [signal] = parseGolangciLintJson(output(raw), CTX);
    expect(signal?.message).toBe('gofmt');
  });

  it('falls back to a `golangci-lint` ruleId when FromLinter is absent', () => {
    const raw = report([{ Text: 'unattributed issue', Pos: { Filename: 'a.go', Line: 1 } }]);
    const [signal] = parseGolangciLintJson(output(raw), CTX);
    expect(signal?.ruleId).toBe('golangci-lint');
  });

  it('returns no signals for a clean run (empty Issues)', () => {
    expect(parseGolangciLintJson(output(report([])), CTX)).toEqual([]);
    expect(
      parseGolangciLintJson(output(JSON.stringify({ Issues: null, Report: {} })), CTX),
    ).toEqual([]);
  });

  it('faults when malformed output would otherwise read as a clean scan', () => {
    expect(() => parseGolangciLintJson(output('not json at all'), CTX)).toThrow(
      expect.objectContaining({ code: 'EXTERNAL.SCANNER.ARTIFACT_INVALID' }),
    );
    expect(() => parseGolangciLintJson(output('{"Issues":[1,"x",null]}'), CTX)).toThrow(
      expect.objectContaining({
        metadata: { condition: 'invalid-issue-record', scanner: 'golangci-lint' },
      }),
    );
  });

  it('retains valid issues and reports invalid sibling records', () => {
    const warn = vi.fn();
    const ctx = { ...CTX, logger: { warn } } as unknown as AdapterRunContext;
    const raw = report([
      {
        FromLinter: 'errcheck',
        Text: 'valid issue',
        Pos: { Filename: 'main.go', Line: 1, Column: 1 },
      },
      null,
    ]);

    expect(parseGolangciLintJson(output(raw), ctx)).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        condition: 'invalid-issue-record',
        droppedIssueCount: 1,
        findingCount: 1,
      }),
    );
  });
});
