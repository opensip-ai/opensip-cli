/**
 * Unit tests for {@link fitReplayFromSession} (coverage gap).
 *
 * `session-payload.ts` (encode) and `session-replay.ts` (decode) are inverses,
 * so the happy path is driven as a round-trip: a real {@link SignalEnvelope} →
 * `buildFitnessSessionPayload` → stored payload → `fitReplayFromSession`. The
 * remaining tests drive each validation branch directly with malformed payloads.
 */

import { buildSignalEnvelope } from '@opensip-tools/contracts';
import { createSignal } from '@opensip-tools/core';
import { describe, expect, it } from 'vitest';

import { buildFitnessSessionPayload } from './session-payload.js';
import { fitReplayFromSession } from './session-replay.js';

import type { StoredSession } from '@opensip-tools/contracts';

function storedSession(payload: unknown, overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'FIT_1',
    tool: 'fit',
    cwd: '/repo',
    timestamp: '2026-06-08T00:00:00.000Z',
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
  it('round-trips a stored payload back into a projection envelope + result', () => {
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
    expect(replay.result.type).toBe('fit-done');
    expect(replay.result.configFound).toBe(true);
  });

  it('labels by recipe when present and carries recipe onto the envelope', () => {
    const replay = fitReplayFromSession(storedSession(realPayload(), { recipe: 'example' }));
    expect(replay.envelope.recipe).toBe('example');
    expect(replay.result.label).toBe('recipe example');
  });

  it('labels by session id when no recipe is set', () => {
    const replay = fitReplayFromSession(storedSession(realPayload()));
    expect(replay.envelope.recipe).toBeUndefined();
    expect(replay.result.label).toBe('session FIT_1');
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
        message: /total must be a number/,
      },
      {
        name: 'missing checks[]',
        payload: { summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 } },
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
