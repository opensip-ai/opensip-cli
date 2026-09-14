/**
 * Unit tests for {@link fitReplayFromSession} (coverage gap).
 *
 * `session-payload.ts` (encode) and `session-replay.ts` (decode) are inverses,
 * so the happy path is driven as a round-trip: a real {@link SignalEnvelope} →
 * `buildFitnessSessionPayload` → stored payload → `fitReplayFromSession`. The
 * remaining tests drive each validation branch directly with malformed payloads.
 */

import { buildSignalEnvelope } from '@opensip-cli/contracts';
import { createSignal, HOST_VERDICT_POLICY_FALLBACK, stampFingerprints } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { fitnessFingerprintStrategy } from '../baseline-strategy.js';

import { buildFitnessSessionPayload } from './session-payload.js';
import { fitReplayFromSession } from './session-replay.js';

import type { StoredSession } from '@opensip-cli/contracts';

function storedSession(payload: unknown, overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'FIT_1',
    tool: 'fit',
    cwd: '/repo',
    startedAt: '2026-06-08T00:00:00.000Z',
    completedAt: '2026-06-08T00:00:00.000Z',
    score: 90,
    passed: true,
    durationMs: 42,
    payload,
    ...overrides,
  };
}

function realPayload() {
  const env = buildSignalEnvelope({
    tool: 'fit',
    runId: 'RUN_test',
    createdAt: '2026-06-08T00:00:00.000Z',
    units: [
      { slug: 'a', passed: false, violationCount: 1, durationMs: 10 },
      { slug: 'clean', passed: true, durationMs: 3 },
    ],
    policy: HOST_VERDICT_POLICY_FALLBACK,
    runFaulted: false,
    signals: [
      createSignal({
        source: 'a',
        severity: 'critical',
        ruleId: 'fit:a',
        message: 'boom',
        code: { file: 'src/x.ts', line: 3, column: 5 },
        suggestion: 'fix it',
      }),
      createSignal({
        source: 'a',
        severity: 'low',
        ruleId: 'fit:a2',
        message: 'nit',
      }),
    ],
  });
  return buildFitnessSessionPayload(env);
}

describe('fitReplayFromSession', () => {
  it('round-trips a stored payload back into a projection envelope + run-presentation result', () => {
    const replay = fitReplayFromSession(storedSession(realPayload()));

    expect(replay.fidelity).toBe('projection');
    expect(replay.envelope.tool).toBe('fit');
    expect(replay.envelope.runId).toBe('FIT_1');
    expect(replay.envelope.verdict.passed).toBe(true);
    expect(replay.envelope.units.map((u) => u.slug)).toEqual(['a', 'clean']);
    // error finding → high, warning finding → medium
    expect(replay.envelope.signals.map((s) => s.severity)).toEqual(['high', 'medium']);
    const located = replay.envelope.signals.find((s) => s.ruleId === 'fit:a');
    expect(located?.code).toEqual({ file: 'src/x.ts', line: 3, column: 5 });
    expect(located?.suggestion).toBe('fix it');
    // The inner replay result is the uniform render-only RunPresentation carrying
    // the projected envelope (the host renders replay via SessionReplayResult, not
    // this inner result).
    expect(replay.result.type).toBe('run-presentation');
    expect(replay.result.tool).toBe('fitness');
    expect(replay.result.envelope).toBe(replay.envelope);
  });

  /**
   * Regression: the envelope replay stamps `baselineIdentity` — it CLAIMS the
   * signals carry the fingerprint identity the gate captured — yet the payload
   * dropped `signal.fingerprint` on encode and the replay never set it, so every
   * replayed signal came back unstamped. A baseline comparison then matched
   * nothing and reported 100% of the stored baseline as RESOLVED ("all N
   * findings were fixed") on a run where nothing had changed.
   *
   * ADR-0036: the plane never re-fingerprints, so the ONLY way a replayed
   * session can be compared is if the round-trip preserves the stamp verbatim.
   */
  it('preserves the stamped fingerprint on every replayed signal (baseline-comparison round-trip)', () => {
    const stamped = stampFingerprints(
      [
        createSignal({
          source: 'a',
          severity: 'critical',
          ruleId: 'fit:a',
          message: 'boom',
          code: { file: 'src/x.ts', line: 3, column: 5 },
        }),
        createSignal({ source: 'a', severity: 'low', ruleId: 'fit:a2', message: 'nit' }),
      ],
      fitnessFingerprintStrategy,
    );
    const env = buildSignalEnvelope({
      tool: 'fit',
      runId: 'RUN_fp',
      createdAt: '2026-06-08T00:00:00.000Z',
      units: [{ slug: 'a', passed: false, violationCount: 2, durationMs: 10 }],
      policy: HOST_VERDICT_POLICY_FALLBACK,
      runFaulted: false,
      signals: stamped,
    });
    const expected = stamped.map((s) => s.fingerprint);
    expect(expected.every((fp) => typeof fp === 'string' && fp.length > 0)).toBe(true);

    // Cloned the way the datastore hands the payload back: a detached blob, not
    // the in-memory object the builder returned.
    const replay = fitReplayFromSession(
      storedSession(structuredClone(buildFitnessSessionPayload(env))),
    );

    expect(replay.envelope.signals.map((s) => s.fingerprint)).toEqual(expected);
    // The envelope claims fingerprint identity; that claim must now be true.
    expect(replay.envelope.baselineIdentity?.fingerprintStrategyId).toBe(
      fitnessFingerprintStrategy.id,
    );
  });

  it('leaves the fingerprint unset for a legacy payload persisted before it was stored', () => {
    const legacy = {
      summary: { total: 1, passed: 0, failed: 1, errors: 1, warnings: 0 },
      checks: [
        {
          checkSlug: 'a',
          passed: false,
          durationMs: 1,
          findings: [{ ruleId: 'r', message: 'm', severity: 'error', filePath: 'src/a.ts' }],
        },
      ],
    };
    const replay = fitReplayFromSession(storedSession(legacy));
    expect(replay.envelope.signals[0]).not.toHaveProperty('fingerprint');
  });

  it('carries the recipe onto the envelope when present', () => {
    const replay = fitReplayFromSession(storedSession(realPayload(), { recipe: 'example' }));
    expect(replay.envelope.recipe).toBe('example');
  });

  it('leaves the envelope recipe unset when no recipe is stored', () => {
    const replay = fitReplayFromSession(storedSession(realPayload()));
    expect(replay.envelope.recipe).toBeUndefined();
  });

  it('preserves a finding with no optional location fields (undefined branches)', () => {
    const payload = {
      summary: { total: 1, passed: 0, failed: 1, errors: 1, warnings: 0 },
      checks: [
        {
          checkSlug: 'a',
          passed: false,
          durationMs: 1,
          findings: [{ ruleId: 'r', message: 'm', severity: 'error' }],
        },
      ],
    };
    const replay = fitReplayFromSession(storedSession(payload));
    const signal = replay.envelope.signals[0];
    expect(signal?.filePath).toBe('');
    expect(signal?.line).toBeUndefined();
    expect(signal?.code).toBeUndefined();
    expect(replay.envelope.units[0]?.violationCount).toBeUndefined();
  });

  describe('payload validation', () => {
    const cases: { name: string; payload: unknown; message: RegExp }[] = [
      { name: 'null payload', payload: null, message: /no replay payload/ },
      {
        name: 'missing summary',
        payload: { checks: [] },
        message: /summary is missing/,
      },
      {
        name: 'non-number summary field',
        payload: {
          summary: { total: 'x', passed: 0, failed: 0, errors: 0, warnings: 0 },
          checks: [],
        },
        message: /total must be a finite number/,
      },
      {
        name: 'missing checks[]',
        payload: {
          summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
        },
        message: /missing checks\[\]/,
      },
      {
        name: 'invalid check row',
        payload: {
          summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
          checks: [null],
        },
        message: /check row is invalid/,
      },
      {
        name: 'check missing findings[]',
        payload: {
          summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
          checks: [{ checkSlug: 'a', passed: true, durationMs: 1 }],
        },
        message: /missing findings\[\]/,
      },
      {
        name: 'invalid finding row',
        payload: {
          summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
          checks: [{ checkSlug: 'a', passed: true, durationMs: 1, findings: [42] }],
        },
        message: /finding is invalid/,
      },
      {
        name: 'invalid finding severity',
        payload: {
          summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
          checks: [
            {
              checkSlug: 'a',
              passed: true,
              durationMs: 1,
              findings: [{ ruleId: 'r', message: 'm', severity: 'info' }],
            },
          ],
        },
        message: /invalid severity/,
      },
    ];

    for (const { name, payload, message } of cases) {
      it(`throws on ${name}`, () => {
        expect(() => fitReplayFromSession(storedSession(payload))).toThrow(message);
      });
    }
  });
});
