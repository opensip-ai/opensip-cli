import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveSession } from '../resolve-session.js';
import { SessionRepo } from '../session-repo.js';

import type { StoredSession } from '@opensip-tools/contracts';

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'FIT_01',
    tool: 'fit',
    timestamp: '2026-05-21T12:00:00.000Z',
    cwd: '/proj',
    recipe: 'default',
    score: 100,
    passed: true,
    durationMs: 100,
    payload: { summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0 }, checks: [] },
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

describe('resolveSession', () => {
  it('rejects latest without a tool', () => {
    const result = resolveSession(datastore, { ref: 'latest' });
    expect(result).toEqual({
      ok: false,
      reason: 'ambiguous-latest',
      detail: 'latest requires --tool fit|graph|sim',
    });
  });

  it('resolves latest scoped to a tool', () => {
    repo.save(makeSession({ id: 'FIT_OLD', tool: 'fit', timestamp: '2026-05-01T00:00:00.000Z' }));
    repo.save(makeSession({ id: 'FIT_NEW', tool: 'fit', timestamp: '2026-05-02T00:00:00.000Z' }));
    repo.save(makeSession({ id: 'GRAPH_NEWER', tool: 'graph', timestamp: '2026-05-03T00:00:00.000Z' }));
    const result = resolveSession(datastore, { ref: 'latest', tool: 'fit' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.session.id).toBe('FIT_NEW');
  });

  it('returns a not-found result when no scoped latest session exists', () => {
    const result = resolveSession(datastore, { ref: 'latest', tool: 'sim' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not-found');
      expect(result.detail).toContain('no sim session found');
    }
  });

  it('resolves a session by id with payload hydrated', () => {
    repo.save(makeSession({ id: 'FIT_BY_ID', payload: { marker: true } }));
    const result = resolveSession(datastore, { ref: 'FIT_BY_ID' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.session.payload).toEqual({ marker: true });
  });

  it('returns not-found for a missing id', () => {
    const result = resolveSession(datastore, { ref: 'NOPE' });
    expect(result).toEqual({
      ok: false,
      reason: 'not-found',
      detail: 'session NOPE was not found',
    });
  });

  it('returns wrong-tool when an id is checked against another tool', () => {
    repo.save(makeSession({ id: 'GRAPH_01', tool: 'graph' }));
    const result = resolveSession(datastore, { ref: 'GRAPH_01', tool: 'fit' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('wrong-tool');
      expect(result.detail).toContain('is a graph session, not fit');
    }
  });
});
