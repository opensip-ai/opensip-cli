/**
 * verdict-envelope — `buildSignalEnvelope`'s verdict computation (ADR-0035).
 * Pins that `verdict.passed = !runFaulted && !unitErrored && policyPasses(...)`,
 * and that the per-unit `summary.{passed,failed}` counts are INDEPENDENT of the
 * run verdict (they feed the table; the verdict feeds the headline + exit code).
 */

import {
  createSignal,
  type Signal,
  type SignalSeverity,
  type VerdictPolicy,
} from '@opensip-tools/core';
import { describe, expect, it } from 'vitest';

import { buildSignalEnvelope, type UnitResult } from './signal-envelope.js';

function sig(severity: SignalSeverity): Signal {
  return createSignal({ source: 'u', severity, ruleId: `r-${severity}`, message: 'x' });
}

const FALLBACK: VerdictPolicy = { failOnErrors: 1, failOnWarnings: 0 };

function verdictOf(opts: {
  signals?: readonly Signal[];
  units?: readonly UnitResult[];
  policy?: VerdictPolicy;
  runFaulted?: boolean;
}) {
  return buildSignalEnvelope({
    tool: 'fit',
    runId: 'r',
    createdAt: '2026-01-01T00:00:00.000Z',
    units: opts.units ?? [{ slug: 'a', passed: true, durationMs: 1 }],
    signals: opts.signals ?? [],
    policy: opts.policy ?? FALLBACK,
    runFaulted: opts.runFaulted ?? false,
  }).verdict;
}

describe('buildSignalEnvelope · verdict.passed (ADR-0035)', () => {
  it('passes a clean run under the {1,0} fallback', () => {
    expect(verdictOf({}).passed).toBe(true);
  });

  it('fails as soon as one error-rung signal is present', () => {
    expect(verdictOf({ signals: [sig('high')] }).passed).toBe(false);
  });

  it('passes a warning-only run under {1,0} (warnings informational)', () => {
    expect(verdictOf({ signals: [sig('medium'), sig('low')] }).passed).toBe(true);
  });

  it('fails a warning-only run when failOnWarnings is active', () => {
    expect(
      verdictOf({ signals: [sig('medium')], policy: { failOnErrors: 1, failOnWarnings: 1 } })
        .passed,
    ).toBe(false);
  });

  it('tolerates errors when failOnErrors is 0 (ratchet/warn-only mode)', () => {
    expect(
      verdictOf({
        signals: [sig('high'), sig('critical')],
        policy: { failOnErrors: 0, failOnWarnings: 0 },
      }).passed,
    ).toBe(true);
  });

  it('FAILS on a run-level fault (runFaulted) even with zero findings', () => {
    expect(verdictOf({ signals: [], runFaulted: true }).passed).toBe(false);
  });

  it('FAILS when a unit carries an error, even with zero signals', () => {
    const errored: UnitResult = { slug: 'boom', passed: false, durationMs: 1, error: 'exploded' };
    expect(verdictOf({ units: [errored], signals: [] }).passed).toBe(false);
  });

  it('keeps summary.{passed,failed} independent of verdict.passed', () => {
    // 1 failing unit (no error/signal) → summary.failed=1, but with no error
    // signals and no fault the policy verdict still PASSES under {1,0}.
    const v = verdictOf({
      units: [
        { slug: 'a', passed: true, durationMs: 1 },
        { slug: 'b', passed: false, durationMs: 1 },
      ],
      signals: [],
    });
    expect(v.summary.passed).toBe(1);
    expect(v.summary.failed).toBe(1);
    expect(v.passed).toBe(true);
  });
});
