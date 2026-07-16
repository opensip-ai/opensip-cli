import { describe, expect, it } from 'vitest';

import {
  latestCompleted,
  missingSuiteGroupMessage,
  reviewRecommendedNext,
  selectSuiteGroup,
} from '../session-review-helpers.js';

import type { HistorySession, HistorySuiteGroup } from '@opensip-cli/contracts';

function group(over: Partial<HistorySuiteGroup> = {}): HistorySuiteGroup {
  return {
    suiteRunId: 'suite-1',
    suiteName: 'audit',
    sessions: [],
    ...over,
  };
}

function session(over: Partial<HistorySession> = {}): HistorySession {
  return {
    id: 's1',
    completedAt: '2026-07-10T00:00:00.000Z',
    ...over,
  } as HistorySession;
}

describe('session-review-helpers', () => {
  it('selects a suite group by suiteRunId or suite name', () => {
    const groups = [
      group({ suiteRunId: 'a', suiteName: 'security' }),
      group({ suiteRunId: 'b', suiteName: 'audit' }),
    ];
    expect(selectSuiteGroup(groups, { suiteRunId: 'b' })?.suiteName).toBe('audit');
    expect(selectSuiteGroup(groups, { suite: 'security' })?.suiteRunId).toBe('a');
    expect(selectSuiteGroup(groups, {})?.suiteRunId).toBe('a');
    expect(selectSuiteGroup(groups, { suite: 'missing' })).toBeUndefined();
  });

  it('describes missing suite groups', () => {
    expect(missingSuiteGroupMessage({ suiteRunId: 'x' })).toContain('x');
    expect(missingSuiteGroupMessage({})).toBe('no stored suite run found');
    expect(missingSuiteGroupMessage({ suite: 'audit' })).toContain('audit');
  });

  it('picks the latest completed timestamp by code-point order', () => {
    expect(
      latestCompleted([
        session({ completedAt: '2026-07-09T00:00:00.000Z' }),
        session({ completedAt: '2026-07-10T12:00:00.000Z' }),
        session({ completedAt: '2026-07-10T00:00:00.000Z' }),
      ]),
    ).toBe('2026-07-10T12:00:00.000Z');
    expect(latestCompleted([])).toBeUndefined();
  });

  it('builds recommended next commands for single/multi session and stale graph', () => {
    expect(reviewRecommendedNext([], false)).toEqual({});
    expect(reviewRecommendedNext([session({ id: 'only' })], false)).toEqual({
      showSourceSessionCommand: 'opensip sessions show only --json',
    });
    expect(reviewRecommendedNext([session({ id: 'a' }), session({ id: 'b' })], true)).toMatchObject(
      {
        showSourceSessionCommand: 'opensip sessions show a --json',
        listSuiteSessionsCommand: 'opensip sessions list --json --summary-only',
        refreshGraphCommand: 'opensip graph --json',
      },
    );
  });
});
