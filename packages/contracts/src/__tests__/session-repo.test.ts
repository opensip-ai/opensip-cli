import { DataStoreFactory, type DataStore } from '@opensip-tools/datastore';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SessionRepo } from '../persistence/session-repo.js';

import type { StoredSession } from '../persistence/store.js';

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: 'ses-test-1',
    tool: 'fit',
    timestamp: '2026-05-21T12:00:00.000Z',
    cwd: '/proj',
    recipe: 'default',
    score: 95,
    passed: true,
    summary: { total: 5, passed: 4, failed: 1, errors: 0, warnings: 1 },
    durationMs: 250,
    checks: [
      {
        checkSlug: 'demo-check',
        passed: true,
        violationCount: 1,
        durationMs: 50,
        findings: [
          {
            ruleId: 'demo-check',
            message: 'demo finding',
            severity: 'warning',
            filePath: 'src/a.ts',
            line: 10,
            column: 0,
          },
        ],
      },
    ],
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

describe('SessionRepo — save / get', () => {
  it('persists a session with checks + findings and reads it back unchanged', () => {
    const session = makeSession();
    repo.save(session);
    const fetched = repo.get(session.id);
    expect(fetched).not.toBeNull();
    expect(fetched).toEqual(session);
  });

  it('returns null when getting a non-existent id', () => {
    expect(repo.get('does-not-exist')).toBeNull();
  });

  it('round-trips empty checks array', () => {
    const session = makeSession({ checks: [] });
    repo.save(session);
    const fetched = repo.get(session.id);
    expect(fetched?.checks).toEqual([]);
  });

  it('round-trips findings with optional fields omitted', () => {
    const session = makeSession({
      checks: [
        {
          checkSlug: 'no-loc',
          passed: true,
          durationMs: 10,
          findings: [{ ruleId: 'no-loc', message: 'global', severity: 'info' }],
        },
      ],
    });
    repo.save(session);
    const fetched = repo.get(session.id);
    const finding = fetched?.checks[0]?.findings[0];
    expect(finding?.filePath).toBeUndefined();
    expect(finding?.line).toBeUndefined();
    expect(finding?.column).toBeUndefined();
  });
});

describe('SessionRepo — list', () => {
  it('lists sessions newest-first by timestamp', () => {
    repo.save(makeSession({ id: 'a', timestamp: '2026-05-01T00:00:00.000Z' }));
    repo.save(makeSession({ id: 'b', timestamp: '2026-05-02T00:00:00.000Z' }));
    repo.save(makeSession({ id: 'c', timestamp: '2026-05-03T00:00:00.000Z' }));
    const ordered = repo.list();
    expect(ordered.map((s) => s.id)).toEqual(['c', 'b', 'a']);
  });

  it('honors limit', () => {
    for (let i = 0; i < 5; i++) {
      const ts = new Date(2026, 0, i + 1).toISOString();
      repo.save(makeSession({ id: `s${String(i)}`, timestamp: ts }));
    }
    expect(repo.list({ limit: 2 })).toHaveLength(2);
  });

  it('honors tool filter', () => {
    repo.save(makeSession({ id: 'fit-1', tool: 'fit' }));
    repo.save(makeSession({ id: 'sim-1', tool: 'sim' }));
    repo.save(makeSession({ id: 'graph-1', tool: 'graph' }));
    const onlyFit = repo.list({ tool: 'fit' });
    expect(onlyFit).toHaveLength(1);
    expect(onlyFit[0]?.id).toBe('fit-1');
  });
});

describe('SessionRepo — purge / clearAll / count', () => {
  it('count() returns the row count', () => {
    expect(repo.count()).toBe(0);
    repo.save(makeSession({ id: 'a' }));
    repo.save(makeSession({ id: 'b' }));
    expect(repo.count()).toBe(2);
  });

  it('purge(date) deletes sessions older than the cutoff and cascades to checks/findings', () => {
    repo.save(makeSession({ id: 'old', timestamp: '2026-01-01T00:00:00.000Z' }));
    repo.save(makeSession({ id: 'recent', timestamp: '2026-05-21T00:00:00.000Z' }));
    const cutoff = new Date('2026-03-01T00:00:00.000Z');
    const removed = repo.purge(cutoff);
    expect(removed).toBe(1);
    expect(repo.get('old')).toBeNull();
    expect(repo.get('recent')).not.toBeNull();
  });

  it('clearAll removes every session', () => {
    repo.save(makeSession({ id: 'a' }));
    repo.save(makeSession({ id: 'b' }));
    expect(repo.clearAll()).toBe(2);
    expect(repo.count()).toBe(0);
  });
});

describe('SessionRepo — JSON round-trip', () => {
  it('preserves the summary aggregate exactly', () => {
    const session = makeSession({
      summary: { total: 100, passed: 90, failed: 10, errors: 3, warnings: 7 },
    });
    repo.save(session);
    expect(repo.get(session.id)?.summary).toEqual(session.summary);
  });
});
