import {
  createSignal,
  defaultFingerprintStrategy,
  defineFingerprintStrategy,
  HOST_VERDICT_POLICY_FALLBACK,
  type Signal,
  type SignalSeverity,
} from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { buildSignalEnvelope, type UnitResult } from './signal-envelope.js';

function signal(severity: SignalSeverity): Signal {
  return createSignal({
    source: 'test',
    severity,
    ruleId: `rule-${severity}`,
    message: `a ${severity} finding`,
  });
}

function unit(slug: string, passed: boolean): UnitResult {
  return { slug, passed, durationMs: 1 };
}

const BASE = {
  tool: 'fit' as const,
  runId: 'run-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  // ADR-0035: verdict is policy-driven. The {1,0} fallback (fail on any error,
  // warnings informational) reproduces the pre-ADR `errors === 0` behavior these
  // baseline cases assert. The full policy matrix lives in verdict-envelope.test.ts.
  policy: HOST_VERDICT_POLICY_FALLBACK,
  runFaulted: false,
};

/** A recognizable non-default strategy for the stamping cases. */
const toolStrategy = defineFingerprintStrategy({
  id: 'test.tool-strategy',
  version: 1,
  fingerprint: (s) => `tool:${s.ruleId}`,
});

describe('buildSignalEnvelope', () => {
  it('stamps the schema version and identity, and passes units through verbatim', () => {
    const units = [unit('a', true), unit('b', true)];
    const signals = [signal('low')];
    const env = buildSignalEnvelope({
      ...BASE,
      recipe: 'example',
      units,
      signals,
      resolutionMode: 'fast',
    });

    expect(env.schemaVersion).toBe(2);
    expect(env.tool).toBe('fit');
    expect(env.recipe).toBe('example');
    expect(env.runId).toBe('run-1');
    expect(env.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(env.resolutionMode).toBe('fast');
    // units pass through, not copies
    expect(env.units).toBe(units);
  });

  // ADR-0036: fingerprints are an envelope-construction concern — every built
  // envelope is gate-ready, so the "tool forgot to stamp" class cannot occur.
  describe('fingerprint stamping (ADR-0036)', () => {
    it('stamps every signal with the host default strategy when none is passed', () => {
      const env = buildSignalEnvelope({
        ...BASE,
        units: [unit('a', false)],
        signals: [signal('low')],
      });
      const stamped = env.signals[0];
      expect(stamped.fingerprint).toBe(defaultFingerprintStrategy.fingerprint(stamped));
      expect(env.baselineIdentity).toEqual({
        fingerprintStrategyId: 'opensip.default.rule-file-line-col',
        fingerprintStrategyVersion: 1,
      });
    });

    it('stamps with the tool strategy when one is passed', () => {
      const env = buildSignalEnvelope({
        ...BASE,
        units: [unit('a', false)],
        signals: [signal('high')],
        fingerprintStrategy: toolStrategy,
      });
      expect(env.signals[0]?.fingerprint).toBe('tool:rule-high');
      expect(env.baselineIdentity.fingerprintStrategyId).toBe('test.tool-strategy');
    });

    it('preserves pre-stamped signals byte-for-byte and by array identity', () => {
      const preStamped = [{ ...signal('low'), fingerprint: 'pre-existing' }];
      const env = buildSignalEnvelope({
        ...BASE,
        units: [unit('a', true)],
        signals: preStamped,
        fingerprintStrategy: defineFingerprintStrategy({
          id: 'test.would-clobber',
          version: 1,
          fingerprint: () => 'would-clobber',
        }),
      });
      expect(env.signals[0]?.fingerprint).toBe('pre-existing');
      // fully pre-stamped sets pass through by identity (no re-allocation)
      expect(env.signals).toBe(preStamped);
    });
  });

  it('derives summary.total/passed/failed from the units (units are what "ran")', () => {
    const env = buildSignalEnvelope({
      ...BASE,
      units: [unit('a', true), unit('b', false), unit('c', true), unit('d', false)],
      signals: [],
    });

    expect(env.verdict.summary.total).toBe(4);
    expect(env.verdict.summary.passed).toBe(2);
    expect(env.verdict.summary.failed).toBe(2);
  });

  it('counts critical and high signals as errors; medium and low as warnings', () => {
    const env = buildSignalEnvelope({
      ...BASE,
      units: [unit('a', false)],
      signals: [signal('critical'), signal('high'), signal('medium'), signal('low')],
    });

    expect(env.verdict.summary.errors).toBe(2);
    expect(env.verdict.summary.warnings).toBe(2);
  });

  it('passed ⇔ zero error-rung signals: a warnings-only run still passes', () => {
    const env = buildSignalEnvelope({
      ...BASE,
      units: [unit('a', true)],
      signals: [signal('medium'), signal('low')],
    });

    expect(env.verdict.summary.errors).toBe(0);
    expect(env.verdict.passed).toBe(true);
  });

  it('passed is false as soon as a single error-rung signal is present', () => {
    const env = buildSignalEnvelope({
      ...BASE,
      // every unit reported passed, but an error-rung signal still fails the run
      units: [unit('a', true)],
      signals: [signal('high')],
    });

    expect(env.verdict.summary.errors).toBe(1);
    expect(env.verdict.passed).toBe(false);
  });

  it('score is passRate over the unit summary (rounded passed/total percentage)', () => {
    const env = buildSignalEnvelope({
      ...BASE,
      units: [unit('a', true), unit('b', true), unit('c', false)],
      signals: [],
    });

    // 2 of 3 passed → round(66.67) === 67
    expect(env.verdict.score).toBe(67);
  });

  it('scores 100 for an empty run (no units) and reports it as passed', () => {
    const env = buildSignalEnvelope({
      ...BASE,
      units: [],
      signals: [],
    });

    expect(env.verdict.summary.total).toBe(0);
    expect(env.verdict.summary.passed).toBe(0);
    expect(env.verdict.summary.failed).toBe(0);
    expect(env.verdict.score).toBe(100);
    expect(env.verdict.passed).toBe(true);
  });

  it('expresses "ran, errored, 0 signals": a unit can carry an error with no signals', () => {
    const errored: UnitResult = {
      slug: 'boom',
      passed: false,
      durationMs: 5,
      error: 'adapter exploded',
    };
    const env = buildSignalEnvelope({
      ...BASE,
      units: [errored],
      signals: [],
    });

    expect(env.units[0]?.error).toBe('adapter exploded');
    expect(env.verdict.summary.failed).toBe(1);
    // no signals → no errors counted, but the failed unit drags the score down
    expect(env.verdict.summary.errors).toBe(0);
    expect(env.verdict.score).toBe(0);
  });

  it('omits optional recipe and resolutionMode when not supplied', () => {
    const env = buildSignalEnvelope({
      ...BASE,
      units: [unit('a', true)],
      signals: [],
    });

    expect(env.recipe).toBeUndefined();
    expect(env.resolutionMode).toBeUndefined();
  });
});
