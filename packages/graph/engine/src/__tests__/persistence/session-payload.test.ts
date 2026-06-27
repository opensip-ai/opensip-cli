import { describe, expect, it } from 'vitest';

import { buildGraphSessionPayload } from '../../persistence/session-payload.js';

import type { Signal, SignalSeverity } from '@opensip-cli/core';

/** A minimal engine Signal for the session-payload builder. */
function sig(over: {
  ruleId: string;
  message: string;
  severity: SignalSeverity;
  filePath: string;
  line?: number;
}): Signal {
  return {
    id: `sig_${over.ruleId}_${String(over.line ?? 0)}`,
    source: 'graph',
    provider: 'opensip-cli',
    severity: over.severity,
    category: 'quality',
    ruleId: over.ruleId,
    message: over.message,
    filePath: over.filePath,
    line: over.line,
    metadata: {},
    createdAt: '2026-06-04T00:00:00.000Z',
  };
}

describe('buildGraphSessionPayload', () => {
  it('persists the full rule-grouped detail from the signals (no cap; engine slugs)', () => {
    const payload = buildGraphSessionPayload([
      sig({
        ruleId: 'graph:god-file',
        message: 'too big',
        severity: 'high',
        filePath: 'a.ts',
        line: 1,
      }),
      sig({
        ruleId: 'graph:dup-body',
        message: 'dup',
        severity: 'low',
        filePath: 'b.ts',
        line: 2,
      }),
      sig({
        ruleId: 'graph:dup-body',
        message: 'dup',
        severity: 'low',
        filePath: 'c.ts',
        line: 3,
      }),
    ]);

    // One check per rule; every finding is kept (3 signals → 3 findings total).
    expect(payload.checks).toHaveLength(2);
    const totalFindings = payload.checks.reduce((n, c) => n + c.findings.length, 0);
    expect(totalFindings).toBe(3);
    // checkSlug stays the ENGINE slug (dashboard metric columns key on it).
    const godFile = payload.checks.find((c) => c.checkSlug === 'graph:god-file');
    expect(godFile).toBeDefined();
    // The rule that emitted a high-severity signal is recorded as failed.
    expect(godFile?.passed).toBe(false);
    expect(godFile?.findings[0]?.severity).toBe('error');
    // Detail carries the fields the dashboard renderer reads.
    expect(godFile?.findings[0]?.filePath).toBe('a.ts');
    // The warnings-only rule passes.
    const dup = payload.checks.find((c) => c.checkSlug === 'graph:dup-body');
    expect(dup?.passed).toBe(true);
    expect(dup?.findings[0]?.severity).toBe('warning');
    // Summary aggregates by severity bucket.
    expect(payload.summary).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      errors: 1,
      warnings: 2,
    });
  });

  it('returns an empty checks list for a run with no signals (no evaluated-rule list)', () => {
    const payload = buildGraphSessionPayload([]);
    expect(payload.checks).toEqual([]);
    expect(payload.summary.total).toBe(0);
  });

  it('records a PASS row for every evaluated rule on a clean run (data, not an empty table)', () => {
    // No signals, but the run evaluated three rules — each becomes a PASS row so
    // the session detail shows the full rule list (parity with fitness).
    const payload = buildGraphSessionPayload(
      [],
      ['graph:large-function', 'graph:cycle', 'graph:dup-body'],
    );
    expect(payload.checks).toHaveLength(3);
    expect(payload.checks.every((c) => c.passed && c.violationCount === 0)).toBe(true);
    expect(payload.checks.map((c) => c.checkSlug).sort()).toEqual([
      'graph:cycle',
      'graph:dup-body',
      'graph:large-function',
    ]);
    expect(payload.summary).toEqual({
      total: 3,
      passed: 3,
      failed: 0,
      errors: 0,
      warnings: 0,
    });
  });

  it('unions evaluated rules with rules that fired (a fired rule keeps its findings)', () => {
    const payload = buildGraphSessionPayload(
      [
        sig({
          ruleId: 'graph:cycle',
          message: 'cyc',
          severity: 'high',
          filePath: 'a.ts',
          line: 1,
        }),
      ],
      ['graph:large-function', 'graph:cycle'],
    );
    expect(payload.checks).toHaveLength(2);
    const cycle = payload.checks.find((c) => c.checkSlug === 'graph:cycle');
    const large = payload.checks.find((c) => c.checkSlug === 'graph:large-function');
    expect(cycle?.passed).toBe(false);
    expect(cycle?.findings).toHaveLength(1);
    expect(large?.passed).toBe(true);
    expect(large?.findings).toHaveLength(0);
    expect(payload.summary).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      errors: 1,
      warnings: 0,
    });
  });
});
