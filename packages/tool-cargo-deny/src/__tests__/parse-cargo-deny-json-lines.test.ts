import { describe, expect, it, vi } from 'vitest';

import { parseCargoDenyJsonLines } from '../parse-cargo-deny-json-lines.js';

import type { AdapterRunContext, ParsedScannerOutput } from '@opensip-cli/external-tool-adapter';

const CTX = {
  projectRoot: '/proj',
  tool: 'cargo-deny',
} as unknown as AdapterRunContext;

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
      output(
        diagnostic({
          severity: 'error',
          message: 'm',
          code: 'L001',
          labels: [],
        }),
      ),
      CTX,
    );
    const [warn] = parseCargoDenyJsonLines(
      output(
        diagnostic({
          severity: 'warning',
          message: 'm',
          code: 'A001',
          labels: [],
        }),
      ),
      CTX,
    );
    expect(err?.severity).toBe('high');
    expect(warn?.severity).toBe('medium');
  });

  it('maps cargo-deny internal bug diagnostics to high severity', () => {
    const [bug] = parseCargoDenyJsonLines(
      output(
        diagnostic({
          severity: 'bug',
          message: 'failed to resolve a workspace dependency',
          code: 'unresolved-workspace-dependency',
          labels: [],
        }),
      ),
      CTX,
    );
    expect(bug?.severity).toBe('high');
  });

  it('derives the category from the code prefix (L* → quality, A* → security)', () => {
    const [license] = parseCargoDenyJsonLines(
      output(
        diagnostic({
          severity: 'error',
          message: 'm',
          code: 'L001',
          labels: [],
        }),
      ),
      CTX,
    );
    const [advisory] = parseCargoDenyJsonLines(
      output(
        diagnostic({
          severity: 'warning',
          message: 'm',
          code: 'A001',
          labels: [],
        }),
      ),
      CTX,
    );
    expect(license?.category).toBe('quality');
    expect(advisory?.category).toBe('security');
  });

  it('IGNORES a non-diagnostic summary line (yields no signal)', () => {
    const raw = JSON.stringify({
      type: 'summary',
      fields: { advisories: { errors: 0 } },
    });
    expect(parseCargoDenyJsonLines(output(raw), CTX)).toEqual([]);
  });

  it('faults when malformed JSON records leave no trustworthy findings', () => {
    expect(() => parseCargoDenyJsonLines(output('{"type":'), CTX)).toThrow(
      expect.objectContaining({
        code: 'EXTERNAL.SCANNER.ARTIFACT_INVALID',
        metadata: { condition: 'malformed-json-line', scanner: 'cargo-deny' },
      }),
    );
  });

  it('retains valid findings and reports a partially malformed stream', () => {
    const warn = vi.fn();
    const ctx = { ...CTX, logger: { warn } } as unknown as AdapterRunContext;
    const raw = [
      diagnostic({ severity: 'error', message: 'valid', code: 'L001', labels: [] }),
      '{"type":',
    ].join('\n');

    expect(parseCargoDenyJsonLines(output(raw), ctx)).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        condition: 'malformed-json-line',
        parseErrorCount: 1,
        findingCount: 1,
      }),
    );
  });

  it('tolerates a diagnostic with no labels (empty file token, no line/column)', () => {
    const [signal] = parseCargoDenyJsonLines(
      output(
        diagnostic({
          severity: 'warning',
          message: 'm',
          code: 'B001',
          labels: [],
        }),
      ),
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

  it('prefers fields.advisory.id as ruleId over the bare code', () => {
    const [signal] = parseCargoDenyJsonLines(
      output(
        diagnostic({
          severity: 'error',
          message: 'Uncontrolled recursion',
          code: 'vulnerability',
          advisory: { id: 'RUSTSEC-2019-0001', package: 'ammonia' },
          labels: [{ span: 'ammonia 0.7.0', line: 4, column: 1 }],
        }),
      ),
      CTX,
    );
    expect(signal?.ruleId).toBe('RUSTSEC-2019-0001');
    expect(signal?.category).toBe('security');
    expect(signal?.metadata).toMatchObject({
      code: 'vulnerability',
      advisoryId: 'RUSTSEC-2019-0001',
    });
  });

  it('maps real cargo-deny codes: banned → quality, vulnerability → security', () => {
    const [banned] = parseCargoDenyJsonLines(
      output(
        diagnostic({
          severity: 'error',
          message: 'crate is banned',
          code: 'banned',
          labels: [],
        }),
      ),
      CTX,
    );
    const [vuln] = parseCargoDenyJsonLines(
      output(
        diagnostic({
          severity: 'error',
          message: 'vuln',
          code: 'vulnerability',
          labels: [],
        }),
      ),
      CTX,
    );
    expect(banned?.category).toBe('quality');
    expect(vuln?.category).toBe('security');
  });

  it('maps bans/license codes that reach the default cargo-deny JSON stream to quality', () => {
    const qualityCodes = [
      // bans
      'not-allowed',
      'unmatched-skip',
      'unnecessary-skip',
      'unmatched-wrapper',
      'unmatched-skip-root',
      'exact-features-mismatch',
      'feature-not-explicitly-allowed',
      'unknown-feature',
      'default-feature-enabled',
      'checksum-mismatch',
      'denied-by-extension',
      'detected-executable',
      'detected-executable-script',
      'unable-to-check-path',
      'unmatched-bypass',
      'unmatched-path-bypass',
      'unmatched-glob',
      'unused-wrapper',
      'workspace-duplicate',
      'unresolved-workspace-dependency',
      'unused-workspace-dependency',
      'non-utf8-path',
      'non-root-path',
      'replaced-in-std',
      'unmatched-replacement-ignore',
      // licenses
      'accepted',
      'rejected',
      'unlicensed',
      'missing-clarification-file',
      'parse-error',
      'gather-failure',
    ];

    for (const code of qualityCodes) {
      const [signal] = parseCargoDenyJsonLines(
        output(diagnostic({ severity: 'error', message: code, code, labels: [] })),
        CTX,
      );
      expect(signal?.category, code).toBe('quality');
    }
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
