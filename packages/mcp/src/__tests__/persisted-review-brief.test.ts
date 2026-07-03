import { createSignal, type Signal } from '@opensip-cli/core';
import { describe, expect, it } from 'vitest';

import { buildPersistedReviewBrief } from '../persisted-review-brief.js';

import type { CommandResult, StoredSession, ToolSessionReplay } from '@opensip-cli/contracts';

function session(id: string, overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id,
    tool: 'fit',
    cwd: '/repo',
    startedAt: '2026-07-02T00:00:00.000Z',
    completedAt: '2026-07-02T00:00:01.000Z',
    durationMs: 1000,
    score: 0,
    passed: false,
    payload: {},
    ...overrides,
  };
}

function replay(
  signals: readonly Signal[] = [finding('src/a.ts', 'added')],
  passed = false,
): ToolSessionReplay<CommandResult> {
  return {
    fidelity: 'projection',
    envelope: {
      schemaVersion: 2,
      tool: 'fit',
      runId: 'run-1',
      createdAt: '2026-07-02T00:00:00.000Z',
      verdict: {
        score: passed ? 100 : 0,
        passed,
        summary: {
          total: 1,
          passed: passed ? 1 : 0,
          failed: passed ? 0 : 1,
          errors: 0,
          warnings: signals.length,
        },
      },
      units: [{ slug: 'unit', passed, violationCount: signals.length, durationMs: 1 }],
      signals,
      baselineIdentity: {
        fingerprintStrategyId: 'test.strategy',
        fingerprintStrategyVersion: 1,
      },
    },
    result: { type: 'done' } as unknown as CommandResult,
  };
}

function finding(file: string, baselineState?: string): Signal {
  return {
    ...createSignal({
      source: 'fit',
      ruleId: 'fit:rule',
      severity: 'medium',
      message: `finding in ${file}`,
      code: { file, line: 1, column: 1 },
      metadata: baselineState === undefined ? {} : { baselineState },
    }),
    fingerprint: `fp:${file}`,
  };
}

describe('buildPersistedReviewBrief', () => {
  it('orders steps, filters focused files, and builds baseline deltas', () => {
    const result = buildPersistedReviewBrief({
      suiteRunId: 'suite-1',
      suiteName: 'audit',
      files: ['src/b.ts'],
      steps: [
        {
          session: session('later', {
            completedAt: '2026-07-02T00:00:03.000Z',
            startedAt: '2026-07-02T00:00:02.000Z',
          }),
          replay: replay([finding('src/b.ts', 'unchanged')]),
        },
        {
          session: session('earlier'),
          replay: replay([finding('src/a.ts', 'added')]),
        },
      ],
      limit: 5,
    });

    expect(result.reviewBrief.suite).toBe('audit');
    expect(result.reviewBrief.changedFiles).toBe(1);
    expect(result.reviewBrief.topRisks.map((risk) => risk.file)).toEqual(['src/b.ts']);
    expect(result.reviewBrief.baselineDelta).toEqual({
      available: true,
      added: 1,
      removed: 0,
      unchanged: 1,
    });
    expect(result.degraded).toBeUndefined();
  });

  it('records replay errors, missing envelopes, missing fingerprints, and failing empty verdicts', () => {
    const result = buildPersistedReviewBrief({
      suiteRunId: 'suite-2',
      steps: [
        { session: session('error'), error: 'decode failed', errorCode: 'decode-error' },
        { session: session('missing-envelope') },
        { session: session('failing-empty'), replay: replay([], false) },
        {
          session: session('missing-fingerprint'),
          replay: replay([
            createSignal({
              source: 'fit',
              ruleId: 'fit:rule',
              severity: 'medium',
              message: 'no fingerprint',
              code: { file: 'src/c.ts' },
            }),
          ]),
        },
      ],
    });

    expect(result.degradedSteps).toBe(2);
    expect(result.reviewBrief.degraded.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        'step-fault',
        'missing-envelope',
        'failing-verdict-without-signals',
        'missing-fingerprint',
        'baseline-delta-unavailable',
      ]),
    );
    expect(result.degraded?.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        'decode-error',
        'missing-suite-evidence',
        'missing-fingerprint',
        'missing-baseline',
      ]),
    );
  });
});
