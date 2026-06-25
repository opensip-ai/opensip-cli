import { describe, expect, it } from 'vitest';

import { buildReplaySignal, buildReplaySignals } from '../session-replay-signal.js';

import type { DecodedSessionCheck, DecodedSessionFinding } from '../session-payload-decode.js';
import type { StoredSession } from '@opensip-cli/contracts';

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'FIT_01',
    tool: 'fit',
    startedAt: '2026-05-21T12:00:00.000Z',
    completedAt: '2026-05-21T12:00:00.000Z',
    cwd: '/proj',
    recipe: 'default',
    score: 100,
    passed: true,
    durationMs: 100,
    payload: {},
    ...overrides,
  };
}

function finding(overrides: Partial<DecodedSessionFinding> = {}): DecodedSessionFinding {
  return { ruleId: 'rule-x', message: 'something', severity: 'warning', ...overrides };
}

describe('buildReplaySignal', () => {
  it('maps an error finding with full location into a high-severity signal with code', () => {
    const stored = makeSession({ id: 'S1' });
    const signal = buildReplaySignal({
      stored,
      source: 'check-a',
      finding: finding({
        severity: 'error',
        ruleId: 'no-foo',
        message: 'no foo',
        filePath: 'src/a.ts',
        line: 10,
        column: 4,
        suggestion: 'remove foo',
      }),
      checkIndex: 1,
      findingIndex: 2,
      toolPrefix: 'fit',
      category: 'quality',
      metadata: { k: 'v' },
    });

    expect(signal).toMatchObject({
      id: 'S1:fit:1:2',
      source: 'check-a',
      provider: 'opensip-cli',
      severity: 'high',
      category: 'quality',
      ruleId: 'no-foo',
      message: 'no foo',
      filePath: 'src/a.ts',
      suggestion: 'remove foo',
      line: 10,
      column: 4,
      metadata: { k: 'v' },
      createdAt: stored.startedAt,
    });
    expect(signal.code).toEqual({ file: 'src/a.ts', line: 10, column: 4 });
  });

  it('maps a warning finding without location to medium severity, omitting optional fields and code', () => {
    const signal = buildReplaySignal({
      stored: makeSession(),
      source: 'check-b',
      finding: finding({ severity: 'warning' }),
      checkIndex: 0,
      findingIndex: 0,
      toolPrefix: 'fit',
      category: 'quality',
    });

    expect(signal.severity).toBe('medium');
    expect(signal.filePath).toBe('');
    expect(signal).not.toHaveProperty('suggestion');
    expect(signal).not.toHaveProperty('line');
    expect(signal).not.toHaveProperty('column');
    // codeLocation returns {} when the finding has no filePath and code is not forced.
    expect(signal).not.toHaveProperty('code');
    expect(signal.metadata).toEqual({});
  });

  it('forces code with the fallback filePath when alwaysIncludeCode is set on a location-less finding', () => {
    const signal = buildReplaySignal({
      stored: makeSession(),
      source: 'check-c',
      finding: finding({ severity: 'warning' }),
      checkIndex: 0,
      findingIndex: 0,
      toolPrefix: 'graph',
      category: 'architecture',
      alwaysIncludeCode: true,
    });

    expect(signal.code).toEqual({ file: '' });
  });
});

describe('buildReplaySignals', () => {
  it('flattens checks × findings, applying the metadata mapper and alwaysIncludeCode', () => {
    const checks: DecodedSessionCheck[] = [
      {
        checkSlug: 'check-1',
        passed: false,
        durationMs: 5,
        findings: [
          finding({ ruleId: 'r1', message: 'm1', filePath: 'a.ts', line: 1 }),
          finding({ ruleId: 'r2', message: 'm2', filePath: 'b.ts' }),
        ],
      },
      {
        checkSlug: 'check-2',
        passed: true,
        durationMs: 2,
        findings: [finding({ ruleId: 'r3', message: 'm3', severity: 'error' })],
      },
    ];

    const signals = buildReplaySignals({
      stored: makeSession({ id: 'S2' }),
      checks,
      toolPrefix: 'graph',
      category: 'architecture',
      metadata: (f) => ({ rule: f.ruleId }),
      alwaysIncludeCode: true,
    });

    expect(signals).toHaveLength(3);
    expect(signals.map((s) => s.id)).toEqual(['S2:graph:0:0', 'S2:graph:0:1', 'S2:graph:1:0']);
    expect(signals[0]?.source).toBe('check-1');
    expect(signals[1]?.source).toBe('check-1');
    expect(signals[2]?.source).toBe('check-2');
    expect(signals[0]?.metadata).toEqual({ rule: 'r1' });
    // alwaysIncludeCode forces code even on the location-less third finding (fallback '').
    expect(signals[2]?.code).toEqual({ file: '' });
  });

  it('omits the metadata mapper and alwaysIncludeCode when not provided (default branches)', () => {
    const signals = buildReplaySignals({
      stored: makeSession(),
      checks: [{ checkSlug: 'c', passed: true, durationMs: 1, findings: [finding()] }],
      toolPrefix: 'fit',
      category: 'quality',
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]?.metadata).toEqual({});
    expect(signals[0]).not.toHaveProperty('code');
  });

  it('returns an empty array when there are no checks', () => {
    expect(
      buildReplaySignals({
        stored: makeSession(),
        checks: [],
        toolPrefix: 'fit',
        category: 'quality',
      }),
    ).toEqual([]);
  });
});
