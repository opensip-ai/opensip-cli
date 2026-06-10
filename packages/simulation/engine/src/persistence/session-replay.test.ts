/**
 * Unit tests for {@link simReplayFromSession} (coverage gap).
 *
 * `session-payload.ts` (encode) and `session-replay.ts` (decode) are inverses,
 * so the happy path is a round-trip: a real {@link SignalEnvelope} →
 * `buildSimulationSessionPayload` → stored payload → `simReplayFromSession`.
 * The remaining tests drive each validation branch with malformed payloads.
 */

import { buildSignalEnvelope } from '@opensip-tools/contracts';
import { createSignal } from '@opensip-tools/core';
import { describe, expect, it } from 'vitest';

import { buildSimulationSessionPayload } from './session-payload.js';
import { simReplayFromSession } from './session-replay.js';

import type { StoredSession } from '@opensip-tools/contracts';

function storedSession(payload: unknown, overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'SIM_1',
    tool: 'sim',
    cwd: '/repo',
    timestamp: '2026-06-08T00:00:00.000Z',
    score: 75,
    passed: false,
    durationMs: 120,
    payload,
    ...overrides,
  };
}

function realPayload() {
  const env = buildSignalEnvelope({
    tool: 'sim',
    runId: 'RUN_test',
    createdAt: '2026-06-08T00:00:00.000Z',
    units: [
      { slug: 'latency', passed: false, violationCount: 1, durationMs: 10 },
      { slug: 'clean', passed: true, durationMs: 2 },
    ],
    signals: [
      createSignal({
        source: 'latency',
        severity: 'critical',
        ruleId: 'sim:latency',
        message: 'too slow',
        code: { file: 'svc.ts', line: 7, column: 1 },
        suggestion: 'add a cache',
      }),
      createSignal({
        source: 'latency',
        severity: 'low',
        ruleId: 'sim:latency2',
        message: 'minor jitter',
      }),
    ],
  });
  return buildSimulationSessionPayload(env);
}

describe('simReplayFromSession', () => {
  it('round-trips a stored payload back into a projection envelope + sim-done result', () => {
    const replay = simReplayFromSession(storedSession(realPayload()));

    expect(replay.fidelity).toBe('projection');
    expect(replay.envelope.tool).toBe('sim');
    expect(replay.envelope.runId).toBe('SIM_1');
    expect(replay.envelope.units.map((u) => u.slug)).toEqual(['latency', 'clean']);
    expect(replay.envelope.signals.map((s) => s.severity)).toEqual(['high', 'medium']);
    const located = replay.envelope.signals.find((s) => s.ruleId === 'sim:latency');
    expect(located?.code).toEqual({ file: 'svc.ts', line: 7, column: 1 });
    expect(located?.suggestion).toBe('add a cache');
    expect(replay.result.type).toBe('sim-done');
    expect(replay.result.cwd).toBe('/repo');
    expect(replay.result.durationMs).toBe(120);
  });

  it('names the recipe when present and carries it onto the envelope', () => {
    const replay = simReplayFromSession(storedSession(realPayload(), { recipe: 'example' }));
    expect(replay.envelope.recipe).toBe('example');
    expect(replay.result.recipeName).toBe('example');
  });

  it("falls back to 'default' recipe name when no recipe is set", () => {
    const replay = simReplayFromSession(storedSession(realPayload()));
    expect(replay.envelope.recipe).toBeUndefined();
    expect(replay.result.recipeName).toBe('default');
  });

  it('preserves a finding with no optional location fields', () => {
    const payload = {
      summary: { total: 1, passed: 0, failed: 1, errors: 1, warnings: 0 },
      checks: [
        {
          checkSlug: 'a',
          passed: false,
          violationCount: 1,
          durationMs: 1,
          findings: [{ ruleId: 'r', message: 'm', severity: 'error' }],
        },
      ],
    };
    const replay = simReplayFromSession(storedSession(payload));
    const signal = replay.envelope.signals[0];
    expect(signal?.filePath).toBe('');
    expect(signal?.line).toBeUndefined();
    expect(signal?.code).toBeUndefined();
  });

  describe('payload validation', () => {
    const cases: { name: string; payload: unknown; message: RegExp }[] = [
      { name: 'null payload', payload: null, message: /no replay payload/ },
      { name: 'missing summary', payload: { checks: [] }, message: /summary is missing/ },
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
          checks: [{ checkSlug: 'a', passed: true, violationCount: 0, durationMs: 1 }],
        },
        message: /missing findings\[\]/,
      },
      {
        name: 'invalid finding row',
        payload: {
          summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
          checks: [
            { checkSlug: 'a', passed: true, violationCount: 1, durationMs: 1, findings: [42] },
          ],
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
              violationCount: 1,
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
        expect(() => simReplayFromSession(storedSession(payload))).toThrow(message);
      });
    }
  });
});
