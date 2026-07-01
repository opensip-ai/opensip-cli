import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { requireDrizzleHandle } from '@opensip-cli/datastore/internal';
import { describe, expect, it } from 'vitest';

import { sessionHostMetrics, sessionToolPayload } from '../schema/sessions.js';
import { SessionRepo } from '../session-repo.js';

import type { StoredSession } from '@opensip-cli/contracts';

function makeSession(id: string, day: number): StoredSession {
  const iso = `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`;
  return {
    id,
    tool: 'fit',
    startedAt: iso,
    completedAt: iso,
    cwd: '/proj',
    score: 100,
    passed: true,
    durationMs: 1,
    payload: { __version: 1, id },
  };
}

function withRepo(fn: (repo: SessionRepo, datastore: DataStore) => void): void {
  const datastore = DataStoreFactory.open({ backend: 'memory' });
  try {
    fn(new SessionRepo(datastore), datastore);
  } finally {
    datastore.close();
  }
}

function tableCount(
  datastore: DataStore,
  table: typeof sessionToolPayload | typeof sessionHostMetrics,
): number {
  return requireDrizzleHandle(datastore).db.select().from(table).all().length;
}

describe('SessionRepo.pruneToCount', () => {
  it('keeps the newest sessions and cascades payload/host-metrics rows', () => {
    withRepo((repo, datastore) => {
      for (let i = 0; i < 10; i += 1) {
        const id = `s${i}`;
        repo.save(makeSession(id, i + 1));
        repo.upsertHostMetrics(id, { persistMs: i });
      }

      expect(repo.pruneToCount(3)).toBe(7);
      expect(repo.list().map((session) => session.id)).toEqual(['s9', 's8', 's7']);
      expect(tableCount(datastore, sessionToolPayload)).toBe(3);
      expect(tableCount(datastore, sessionHostMetrics)).toBe(3);
    });
  });

  it('treats zero and negative keep values as disabled', () => {
    withRepo((repo) => {
      repo.save(makeSession('a', 1));
      repo.save(makeSession('b', 2));

      expect(repo.pruneToCount(0)).toBe(0);
      expect(repo.pruneToCount(-1)).toBe(0);
      expect(repo.count()).toBe(2);
    });
  });

  it('composes with age purge', () => {
    withRepo((repo) => {
      for (let i = 0; i < 5; i += 1) {
        repo.save(makeSession(`s${i}`, i + 1));
      }

      expect(repo.pruneToCount(4)).toBe(1);
      expect(repo.purge(new Date('2026-01-04T00:00:00.000Z'))).toBe(2);
      expect(repo.list().map((session) => session.id)).toEqual(['s4', 's3']);
    });
  });
});
