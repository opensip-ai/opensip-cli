import { describe, expect, it } from 'vitest';

import {
  buildSuiteSessionGroups,
  orderSessionsForSuiteGrouping,
} from '../suite-session-grouping.js';

describe('suite-session-grouping', () => {
  it('builds suite groups from stamped sessions', () => {
    const groups = buildSuiteSessionGroups([
      {
        id: 'a',
        suiteRunId: 'run-1',
        suiteName: 'security',
        startedAt: '2026-06-28T10:00:00.000Z',
      },
      {
        id: 'b',
        suiteRunId: 'run-1',
        suiteName: 'security',
        startedAt: '2026-06-28T10:01:00.000Z',
      },
      { id: 'c', startedAt: '2026-06-28T09:00:00.000Z' },
    ]);

    expect(groups).toEqual([
      {
        suiteRunId: 'run-1',
        suiteName: 'security',
        sessions: [
          {
            id: 'b',
            suiteRunId: 'run-1',
            suiteName: 'security',
            startedAt: '2026-06-28T10:01:00.000Z',
          },
          {
            id: 'a',
            suiteRunId: 'run-1',
            suiteName: 'security',
            startedAt: '2026-06-28T10:00:00.000Z',
          },
        ],
      },
    ]);
  });

  it('orders suite members contiguously for report rendering', () => {
    const ordered = orderSessionsForSuiteGrouping([
      { id: 'solo', startedAt: '2026-06-28T11:00:00.000Z' },
      { id: 'b', suiteRunId: 'run-1', startedAt: '2026-06-28T10:01:00.000Z' },
      { id: 'a', suiteRunId: 'run-1', startedAt: '2026-06-28T10:00:00.000Z' },
    ]);

    expect(ordered.map((session) => session.id)).toEqual(['solo', 'b', 'a']);
  });
});
