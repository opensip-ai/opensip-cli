/**
 * Unit tests for {@link buildFitnessSessionPayload} (coverage gap).
 *
 * Drives the payload builder off a real {@link SignalEnvelope}: signals are
 * grouped by `source` onto their unit, the 4-level severity is collapsed to the
 * dashboard's `error|warning` (critical|high → error, else warning), a unit
 * with no matching signals gets an empty `findings[]`, and the `summary` is
 * carried through from the envelope verdict.
 */

import { buildSignalEnvelope } from '@opensip-tools/contracts';
import { createSignal } from '@opensip-tools/core';
import { describe, expect, it } from 'vitest';

import { buildFitnessSessionPayload } from './session-payload.js';

import type { SignalSeverity } from '@opensip-tools/core';

function sig(source: string, severity: SignalSeverity, ruleId = `fit:${source}`) {
  return createSignal({
    source,
    severity,
    ruleId,
    message: `${severity} from ${source}`,
    code: { file: 'src/x.ts', line: 3, column: 5 },
    suggestion: 'fix it',
  });
}

function envelope(units: { slug: string; passed: boolean; violationCount?: number; durationMs?: number }[], signals: ReturnType<typeof sig>[]) {
  return buildSignalEnvelope({
    tool: 'fit',
    runId: 'RUN_test',
    createdAt: '2026-06-05T00:00:00.000Z',
    units: units.map((u) => ({ slug: u.slug, passed: u.passed, violationCount: u.violationCount, durationMs: u.durationMs ?? 10 })),
    signals,
  });
}

describe('buildFitnessSessionPayload', () => {
  it('groups multiple signals from the same source onto one check (push branch)', () => {
    const env = envelope(
      [{ slug: 'a', passed: false, violationCount: 2 }],
      [sig('a', 'critical'), sig('a', 'low')],
    );
    const payload = buildFitnessSessionPayload(env);
    expect(payload.checks).toHaveLength(1);
    expect(payload.checks[0]?.findings).toHaveLength(2);
    expect(payload.checks[0]?.checkSlug).toBe('a');
    expect(payload.checks[0]?.violationCount).toBe(2);
  });

  it('collapses 4-level severity to 2-level (critical|high → error, else warning)', () => {
    const env = envelope(
      [{ slug: 'a', passed: false }, { slug: 'b', passed: false }],
      [sig('a', 'high'), sig('b', 'medium')],
    );
    const payload = buildFitnessSessionPayload(env);
    const a = payload.checks.find((c) => c.checkSlug === 'a');
    const b = payload.checks.find((c) => c.checkSlug === 'b');
    expect(a?.findings[0]?.severity).toBe('error');
    expect(b?.findings[0]?.severity).toBe('warning');
  });

  it('a unit with no matching signals gets an empty findings list (?? [] branch)', () => {
    const env = envelope([{ slug: 'clean', passed: true }], []);
    const payload = buildFitnessSessionPayload(env);
    expect(payload.checks[0]?.findings).toEqual([]);
    expect(payload.checks[0]?.passed).toBe(true);
  });

  it('carries the envelope verdict summary through and preserves finding location fields', () => {
    const env = envelope(
      [{ slug: 'a', passed: false }, { slug: 'ok', passed: true }],
      [sig('a', 'critical')],
    );
    const payload = buildFitnessSessionPayload(env);
    expect(payload.summary).toEqual({ total: 2, passed: 1, failed: 1, errors: 1, warnings: 0 });
    const finding = payload.checks.find((c) => c.checkSlug === 'a')?.findings[0];
    expect(finding?.filePath).toBe('src/x.ts');
    expect(finding?.line).toBe(3);
    expect(finding?.column).toBe(5);
    expect(finding?.suggestion).toBe('fix it');
  });
});
