import { describe, expect, it } from 'vitest';

import { parseCargoClippyJsonLines } from '../parse-cargo-clippy-json-lines.js';

import type { AdapterRunContext, ParsedScannerOutput } from '@opensip-cli/external-tool-adapter';

const CTX = {
  projectRoot: '/proj',
  tool: 'cargo-clippy',
} as unknown as AdapterRunContext;

/** cargo clippy streams cargo NDJSON to stdout. */
function output(lines: string[]): ParsedScannerOutput {
  return { kind: 'stdout', raw: lines.join('\n') };
}

const compilerMessage = (message: Record<string, unknown>): string =>
  JSON.stringify({ reason: 'compiler-message', message });

describe('parseCargoClippyJsonLines', () => {
  it('normalizes a lint with a primary span (code → ruleId, span → location)', () => {
    const raw = output([
      compilerMessage({
        message: 'unneeded return statement',
        level: 'warning',
        code: { code: 'clippy::needless_return' },
        spans: [
          {
            file_name: 'src/lib.rs',
            line_start: 5,
            column_start: 9,
            is_primary: true,
          },
        ],
        rendered: 'warning: ...',
      }),
    ]);
    const signals = parseCargoClippyJsonLines(raw, CTX);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      ruleId: 'clippy::needless_return',
      severity: 'medium',
      message: 'unneeded return statement',
      filePath: 'src/lib.rs',
      line: 5,
      column: 9,
    });
  });

  it('SKIPS a spanless rustc aggregate message (no bogus signal)', () => {
    const raw = output([
      compilerMessage({
        message: 'aborting due to 2 previous errors',
        level: 'error',
        code: null,
        spans: [],
      }),
    ]);
    const signals = parseCargoClippyJsonLines(raw, CTX);
    expect(signals).toEqual([]);
  });

  it('does not emit a high signal for a spanless summary alongside a real lint', () => {
    const raw = output([
      // non-compiler-message line — skipped
      JSON.stringify({ reason: 'compiler-artifact', fresh: false }),
      compilerMessage({
        message: 'unneeded return statement',
        level: 'warning',
        code: { code: 'clippy::needless_return' },
        spans: [
          {
            file_name: 'src/lib.rs',
            line_start: 5,
            column_start: 9,
            is_primary: true,
          },
        ],
      }),
      // spanless summary — skipped
      compilerMessage({
        message: '1 warning emitted',
        level: 'warning',
        code: null,
        spans: [],
      }),
      JSON.stringify({ reason: 'build-finished', success: false }),
    ]);
    const signals = parseCargoClippyJsonLines(raw, CTX);
    expect(signals).toHaveLength(1);
    expect(signals.some((s) => s.severity === 'high')).toBe(false);
  });

  it('maps an error-level lint (with a span) to high severity', () => {
    const raw = output([
      compilerMessage({
        message: 'this operation is dangerous',
        level: 'error',
        code: { code: 'clippy::deny_something' },
        spans: [
          {
            file_name: 'src/main.rs',
            line_start: 1,
            column_start: 1,
            is_primary: true,
          },
        ],
      }),
    ]);
    const [signal] = parseCargoClippyJsonLines(raw, CTX);
    expect(signal?.severity).toBe('high');
  });

  it('falls back to the first span when none is marked primary', () => {
    const raw = output([
      compilerMessage({
        message: 'lint without a primary span',
        level: 'warning',
        code: { code: 'clippy::x' },
        spans: [
          {
            file_name: 'src/first.rs',
            line_start: 2,
            column_start: 3,
            is_primary: false,
          },
        ],
      }),
    ]);
    const [signal] = parseCargoClippyJsonLines(raw, CTX);
    expect(signal?.filePath).toBe('src/first.rs');
    expect(signal?.line).toBe(2);
  });

  it('falls back to a `clippy` ruleId when the message has no code', () => {
    const raw = output([
      compilerMessage({
        message: 'a warning without a lint code',
        level: 'warning',
        code: null,
        spans: [
          {
            file_name: 'src/x.rs',
            line_start: 1,
            column_start: 1,
            is_primary: true,
          },
        ],
      }),
    ]);
    const [signal] = parseCargoClippyJsonLines(raw, CTX);
    expect(signal?.ruleId).toBe('clippy');
  });

  it('skips a compiler-message that carries no `message` text', () => {
    const raw = output([
      compilerMessage({
        level: 'warning',
        code: { code: 'clippy::x' },
        spans: [
          {
            file_name: 'src/x.rs',
            line_start: 1,
            column_start: 1,
            is_primary: true,
          },
        ],
      }),
    ]);
    expect(parseCargoClippyJsonLines(raw, CTX)).toEqual([]);
  });

  it('omits line/column when the primary span has no line_start/column_start', () => {
    const raw = output([
      compilerMessage({
        message: 'span without coordinates',
        level: 'warning',
        code: { code: 'clippy::x' },
        spans: [{ file_name: 'src/x.rs', is_primary: true }],
        rendered: 'warning: ...',
      }),
    ]);
    const [signal] = parseCargoClippyJsonLines(raw, CTX);
    expect(signal?.filePath).toBe('src/x.rs');
    expect(signal?.line).toBeUndefined();
    expect(signal?.column).toBeUndefined();
  });

  it('tolerates a lint with no `rendered` explanation (empty file token too)', () => {
    const raw = output([
      compilerMessage({
        message: 'no rendered field',
        level: 'warning',
        code: { code: 'clippy::x' },
        spans: [{ line_start: 4, column_start: 6, is_primary: true }],
      }),
    ]);
    const [signal] = parseCargoClippyJsonLines(raw, CTX);
    expect(signal?.filePath).toBe('');
    expect(signal?.line).toBe(4);
  });

  it('returns no signals for a clean run and tolerates non-JSON', () => {
    expect(parseCargoClippyJsonLines(output(['']), CTX)).toEqual([]);
    expect(parseCargoClippyJsonLines(output(['not json']), CTX)).toEqual([]);
  });
});
