/**
 * Unit tests for {@link graphReplayFromSession} (coverage gap).
 *
 * `session-payload.ts` (encode) and `session-replay.ts` (decode) are inverses,
 * so the happy path is a round-trip: `Signal[]` → `buildGraphSessionPayload` →
 * stored payload → `graphReplayFromSession`. The remaining tests drive each
 * validation branch directly with malformed payloads.
 */

import { stampFingerprints } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { graphFingerprintStrategy } from '../../baseline-strategy.js';
import { buildGraphSessionPayload } from '../../persistence/session-payload.js';
import { graphReplayFromSession } from '../../persistence/session-replay.js';

import type { StoredSession } from '@opensip-cli/contracts';
import type { Signal } from '@opensip-cli/core';

function sig(
  over: Partial<Signal> & {
    ruleId: string;
    severity: Signal['severity'];
    filePath: string;
  },
): Signal {
  return {
    id: `sig_${over.ruleId}`,
    source: 'graph',
    provider: 'opensip-cli',
    category: 'architecture',
    message: `${over.severity} ${over.ruleId}`,
    metadata: {},
    createdAt: '2026-06-08T00:00:00.000Z',
    ...over,
  };
}

function storedSession(payload: unknown, overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'GRAPH_1',
    tool: 'graph',
    cwd: '/repo',
    startedAt: '2026-06-08T00:00:00.000Z',
    completedAt: '2026-06-08T00:00:00.000Z',
    score: 80,
    passed: false,
    durationMs: 99,
    payload,
    ...overrides,
  };
}

describe('graphReplayFromSession', () => {
  it('round-trips a stored payload back into a projection envelope + run-presentation result', () => {
    const payload = buildGraphSessionPayload([
      sig({
        ruleId: 'graph:god-file',
        severity: 'high',
        filePath: 'a.ts',
        line: 1,
        column: 2,
        suggestion: 'split it',
        metadata: { fanIn: 12, label: 'big', flagged: true },
      }),
      sig({ ruleId: 'graph:dup-body', severity: 'low', filePath: 'b.ts' }),
    ]);

    const replay = graphReplayFromSession(storedSession(payload));

    expect(replay.fidelity).toBe('projection');
    expect(replay.envelope.tool).toBe('graph');
    expect(replay.envelope.runId).toBe('GRAPH_1');
    expect(replay.envelope.signals.map((s) => s.severity)).toEqual(['high', 'medium']);
    const located = replay.envelope.signals.find((s) => s.ruleId === 'graph:god-file');
    expect(located?.code).toEqual({ file: 'a.ts', line: 1, column: 2 });
    expect(located?.suggestion).toBe('split it');
    expect(located?.metadata).toEqual({
      fanIn: 12,
      label: 'big',
      flagged: true,
    });
    // The inner replay result is the uniform render-only RunPresentation carrying
    // the projected envelope (the host renders replay via SessionReplayResult, not
    // this inner result).
    expect(replay.result.type).toBe('run-presentation');
    expect(replay.result.tool).toBe('graph');
    expect(replay.result.envelope).toBe(replay.envelope);
  });

  /**
   * Regression: the projected envelope stamps `baselineIdentity` — it CLAIMS the
   * signals carry the fingerprint identity `--gate-save` captured — but the
   * payload dropped `signal.fingerprint` on encode and the replay never set it.
   * Every replayed signal therefore came back unstamped, so
   * `compare_to_baseline` matched nothing and reported 100% of the stored
   * baseline as RESOLVED on a run where nothing had changed.
   *
   * ADR-0036: the plane never re-fingerprints; only a faithful round-trip of the
   * construction-time stamp makes a replayed session comparable.
   */
  it('preserves the stamped fingerprint on every replayed signal (baseline-comparison round-trip)', () => {
    const stamped = stampFingerprints(
      [
        sig({ ruleId: 'graph:god-file', severity: 'high', filePath: 'a.ts', line: 1, column: 2 }),
        sig({ ruleId: 'graph:dup-body', severity: 'low', filePath: 'b.ts', line: 7 }),
      ],
      graphFingerprintStrategy,
    );
    const expected = stamped.map((s) => s.fingerprint);
    expect(expected).toEqual(['graph:god-file|a.ts|1|2', 'graph:dup-body|b.ts|7|0']);

    // Cloned the way the datastore hands the opaque payload back: a detached
    // blob, not the in-memory object the builder returned.
    const replay = graphReplayFromSession(
      storedSession(structuredClone(buildGraphSessionPayload(stamped))),
    );

    expect(replay.envelope.signals.map((s) => s.fingerprint)).toEqual(expected);
    expect(replay.envelope.baselineIdentity?.fingerprintStrategyId).toBe(
      graphFingerprintStrategy.id,
    );
  });

  it('leaves the fingerprint unset for a legacy payload persisted before it was stored', () => {
    const payload = buildGraphSessionPayload([
      sig({ ruleId: 'graph:r', severity: 'high', filePath: 'x.ts' }),
    ]);
    const replay = graphReplayFromSession(storedSession(payload));
    expect(replay.envelope.signals[0]?.fingerprint).toBeUndefined();
  });

  it('carries recipe onto the envelope when present', () => {
    const payload = buildGraphSessionPayload([]);
    const replay = graphReplayFromSession(storedSession(payload, { recipe: 'example' }));
    expect(replay.envelope.recipe).toBe('example');
  });

  it('preserves a finding with no optional location fields', () => {
    const payload = {
      summary: { total: 1, passed: 0, failed: 1, errors: 1, warnings: 0 },
      checks: [
        {
          checkSlug: 'graph:r',
          passed: false,
          violationCount: 1,
          durationMs: 0,
          findings: [{ ruleId: 'r', message: 'm', severity: 'error', filePath: 'x.ts' }],
        },
      ],
    };
    const replay = graphReplayFromSession(storedSession(payload));
    const signal = replay.envelope.signals[0];
    expect(signal?.line).toBeUndefined();
    expect(signal?.code).toEqual({ file: 'x.ts' });
    expect(signal?.metadata).toEqual({});
  });

  it('drops non-scalar metadata entries and an all-empty metadata bag', () => {
    const payload = {
      summary: { total: 1, passed: 0, failed: 1, errors: 1, warnings: 0 },
      checks: [
        {
          checkSlug: 'graph:r',
          passed: false,
          violationCount: 1,
          durationMs: 0,
          findings: [
            {
              ruleId: 'r',
              message: 'm',
              severity: 'error',
              filePath: 'x.ts',
              metadata: { keep: 'yes', drop: { nested: true } },
            },
          ],
        },
      ],
    };
    const replay = graphReplayFromSession(storedSession(payload));
    expect(replay.envelope.signals[0]?.metadata).toEqual({ keep: 'yes' });
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
          checks: [{ checkSlug: 'a', passed: true, violationCount: 0, durationMs: 0 }],
        },
        message: /missing findings\[\]/,
      },
      {
        name: 'invalid finding row',
        payload: {
          summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
          checks: [
            {
              checkSlug: 'a',
              passed: true,
              violationCount: 1,
              durationMs: 0,
              findings: [42],
            },
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
              durationMs: 0,
              findings: [
                {
                  ruleId: 'r',
                  message: 'm',
                  severity: 'info',
                  filePath: 'x.ts',
                },
              ],
            },
          ],
        },
        message: /invalid severity/,
      },
      {
        name: 'finding missing filePath',
        payload: {
          summary: { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
          checks: [
            {
              checkSlug: 'a',
              passed: true,
              violationCount: 1,
              durationMs: 0,
              findings: [{ ruleId: 'r', message: 'm', severity: 'error' }],
            },
          ],
        },
        message: /filePath must be a string/,
      },
    ];

    for (const { name, payload, message } of cases) {
      it(`throws on ${name}`, () => {
        expect(() => graphReplayFromSession(storedSession(payload))).toThrow(message);
      });
    }
  });
});
