import { ToolRegistry } from '@opensip-cli/core';
import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listSessionSummaries } from '../list-summaries.js';
import { SessionRepo } from '../session-repo.js';

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
    payload: {
      summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0 },
    },
    ...overrides,
  };
}

let datastore: DataStore;
let repo: SessionRepo;

beforeEach(() => {
  datastore = DataStoreFactory.open({ backend: 'memory' });
  repo = new SessionRepo(datastore);
});

afterEach(() => {
  datastore.close();
});

describe('listSessionSummaries', () => {
  it('returns an empty history when no sessions exist', () => {
    expect(listSessionSummaries(datastore)).toEqual({
      type: 'history',
      sessions: [],
    });
  });

  it('maps sessions to history rows with showCommand and optional summary', () => {
    repo.save(makeSession({ id: 'FIT_A' }));
    repo.save(
      makeSession({
        id: 'FIT_B',
        payload: { summary: { total: 2, passed: 1, failed: 1, errors: 1, warnings: 0 } },
      }),
    );
    repo.save(makeSession({ id: 'FIT_C', payload: { summary: 'invalid' } }));

    const result = listSessionSummaries(datastore, { summaryOnly: true });

    expect(result.type).toBe('history');
    expect(result.sessions).toHaveLength(3);
    const withSummary = result.sessions.find((session) => session.id === 'FIT_B');
    const withoutSummary = result.sessions.find((session) => session.id === 'FIT_C');
    expect(withSummary?.showCommand).toBe('opensip sessions show FIT_B --json');
    expect(withSummary?.summary).toEqual({
      total: 2,
      passed: 1,
      failed: 1,
      errors: 1,
      warnings: 0,
    });
    expect(withSummary?.payload).toBeUndefined();
    expect(withoutSummary?.summary).toBeUndefined();
  });

  it('filters by tool and limit and renders canonical tool names from a registry', () => {
    const tools = new ToolRegistry();
    tools.register({
      identity: { name: 'fitness', aliases: ['fit'], layoutKey: 'fit' },
      metadata: {
        id: '00000000-0000-4000-8000-000000000301',
        name: 'fitness',
        version: '0.0.0',
        description: 'fitness',
      },
      commands: [{ name: 'fit', description: 'fit' }],
    });
    repo.save(makeSession({ id: 'FIT_OLD', tool: 'fit', startedAt: '2026-05-01T00:00:00.000Z' }));
    repo.save(makeSession({ id: 'FIT_NEW', tool: 'fit', startedAt: '2026-05-02T00:00:00.000Z' }));
    repo.save(makeSession({ id: 'GRAPH_1', tool: 'graph', startedAt: '2026-05-03T00:00:00.000Z' }));

    const result = listSessionSummaries(datastore, {
      tool: 'fit',
      limit: 1,
      registry: tools,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]?.id).toBe('FIT_NEW');
    expect(result.sessions[0]?.tool).toBe('fitness');
  });

  it('includes suiteGroups when sessions carry suiteRunId', () => {
    repo.save(
      makeSession({
        id: 'STEP_1',
        suiteRunId: 'run-1',
        suiteName: 'security',
        startedAt: '2026-06-28T10:00:00.000Z',
      }),
    );
    repo.save(
      makeSession({
        id: 'STEP_2',
        suiteRunId: 'run-1',
        suiteName: 'security',
        startedAt: '2026-06-28T10:01:00.000Z',
      }),
    );

    const result = listSessionSummaries(datastore);

    expect(result.suiteGroups).toEqual([
      {
        suiteRunId: 'run-1',
        suiteName: 'security',
        sessions: [
          expect.objectContaining({ id: 'STEP_2' }),
          expect.objectContaining({ id: 'STEP_1' }),
        ],
      },
    ]);
  });
});
