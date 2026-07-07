import { describe, expect, it } from 'vitest';

import { parseCargoDenyJsonLines } from '../parse-cargo-deny-json-lines.js';

import type { AdapterRunContext, ParsedScannerOutput } from '@opensip-cli/external-tool-adapter';

const CTX = { projectRoot: '/proj', tool: 'cargo-deny' } as unknown as AdapterRunContext;

/** cargo-deny writes NDJSON to stdout — the run loop hands the parser a stdout output. */
function output(raw: string): ParsedScannerOutput {
  return { kind: 'stdout', raw };
}

const diagnostic = (fields: Record<string, unknown>): string =>
  JSON.stringify({ type: 'diagnostic', fields });

describe('parseCargoDenyJsonLines', () => {
  it('normalizes a diagnostic (code → ruleId, label span/line/column → location)', () => {
    const raw = diagnostic({
      severity: 'error',
      message: 'license not allowed',
      code: 'L001',
      labels: [{ span: 'foo 1.0 registry+https://x', line: 3, column: 1 }],
    });
    const signals = parseCargoDenyJsonLines(output(raw), CTX);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      ruleId: 'L001',
      message: 'license not allowed',
      filePath: 'foo 1.0 registry+https://x',
      line: 3,
      column: 1,
    });
  });

  it('maps severity error → high and warning → medium', () => {
    const [err] = parseCargoDenyJsonLines(
      output(diagnostic({ severity: 'error', message: 'm', code: 'L001', labels: [] })),
      CTX,
    );
    const [warn] = parseCargoDenyJsonLines(
      output(diagnostic({ severity: 'warning', message: 'm', code: 'A001', labels: [] })),
      CTX,
    );
    expect(err?.severity).toBe('high');
    expect(warn?.severity).toBe('medium');
  });

  it('derives the category from the code prefix (L* → quality, A* → security)', () => {
    const [license] = parseCargoDenyJsonLines(
      output(diagnostic({ severity: 'error', message: 'm', code: 'L001', labels: [] })),
      CTX,
    );
    const [advisory] = parseCargoDenyJsonLines(
      output(diagnostic({ severity: 'warning', message: 'm', code: 'A001', labels: [] })),
      CTX,
    );
    expect(license?.category).toBe('quality');
    expect(advisory?.category).toBe('security');
  });

  it('IGNORES a non-diagnostic summary line (yields no signal)', () => {
    const raw = JSON.stringify({ type: 'summary', fields: { advisories: { errors: 0 } } });
    expect(parseCargoDenyJsonLines(output(raw), CTX)).toEqual([]);
  });

  it('tolerates a diagnostic with no labels (empty file token, no line/column)', () => {
    const [signal] = parseCargoDenyJsonLines(
      output(diagnostic({ severity: 'warning', message: 'm', code: 'B001', labels: [] })),
      CTX,
    );
    expect(signal?.filePath).toBe('');
    expect(signal?.line).toBeUndefined();
    expect(signal?.column).toBeUndefined();
    // B* prefix ⇒ quality (bans/duplicates policy).
    expect(signal?.category).toBe('quality');
  });

  it('falls back to a `cargo-deny` ruleId when no code is present', () => {
    const [signal] = parseCargoDenyJsonLines(
      output(diagnostic({ severity: 'error', message: 'm', labels: [] })),
      CTX,
    );
    expect(signal?.ruleId).toBe('cargo-deny');
  });

  it('skips a diagnostic with no message', () => {
    expect(
      parseCargoDenyJsonLines(output(diagnostic({ severity: 'error', code: 'L001' })), CTX),
    ).toEqual([]);
  });

  it('returns no signals for a clean run (empty output)', () => {
    expect(parseCargoDenyJsonLines(output(''), CTX)).toEqual([]);
  });

  it('tolerates malformed / non-JSON lines without throwing (zero signals)', () => {
    expect(parseCargoDenyJsonLines(output('not json at all'), CTX)).toEqual([]);
    expect(parseCargoDenyJsonLines(output('{"unexpected":"object"}'), CTX)).toEqual([]);
  });
});
