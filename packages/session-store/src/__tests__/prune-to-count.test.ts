import { DataStoreFactory, type DataStore } from '@opensip-cli/datastore';
import { requireDrizzleHandle } from '@opensip-cli/datastore/internal';
import { describe, expect, it, vi } from 'vitest';

import { sessionHostMetrics, sessionToolPayload } from '../schema/sessions.js';
import { MAX_SESSION_MAINTENANCE_BATCH_SIZE, SessionRepo } from '../session-repo.js';

import type { StoredSession } from '@opensip-cli/contracts';

function makeSessionAt(id: string, iso: string): StoredSession {
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

function makeSession(id: string, day: number): StoredSession {
  return makeSessionAt(id, `2026-01-${String(day).padStart(2, '0')}T00:00:00.000Z`);
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

describe('SessionRepo bounded maintenance batches', () => {
  it('prunes at most one batch in deterministic timestamp/ID order', () => {
    withRepo((repo, datastore) => {
      const tiedTimestamp = '2026-01-01T00:00:00.000Z';
      for (const id of ['f', 'b', 'e', 'a', 'd', 'c']) {
        repo.save(makeSessionAt(id, tiedTimestamp));
        repo.upsertHostMetrics(id, { persistMs: 1 });
      }

      expect(repo.pruneToCountBatch(2, 2)).toBe(2);
      expect(repo.get('a')).toBeNull();
      expect(repo.get('b')).toBeNull();
      expect(repo.count()).toBe(4);
      expect(tableCount(datastore, sessionToolPayload)).toBe(4);
      expect(tableCount(datastore, sessionHostMetrics)).toBe(4);

      expect(repo.pruneToCountBatch(2, 2)).toBe(2);
      expect(repo.get('c')).toBeNull();
      expect(repo.get('d')).toBeNull();
      expect(
        repo
          .list()
          .map((session) => session.id)
          .sort(),
      ).toEqual(['e', 'f']);
      expect(repo.pruneToCountBatch(2, 2)).toBe(0);
    });
  });

  it('purges at most one batch in deterministic timestamp/ID order', () => {
    withRepo((repo) => {
      repo.save(makeSessionAt('z', '2026-01-01T00:00:00.000Z'));
      for (const id of ['c', 'a', 'b']) {
        repo.save(makeSessionAt(id, '2026-01-02T00:00:00.000Z'));
      }
      repo.save(makeSessionAt('cutoff', '2026-01-03T00:00:00.000Z'));

      const cutoff = new Date('2026-01-03T00:00:00.000Z');
      expect(repo.purgeBatch(cutoff, 2)).toBe(2);
      expect(repo.get('z')).toBeNull();
      expect(repo.get('a')).toBeNull();
      expect(repo.get('b')).not.toBeNull();
      expect(repo.get('cutoff')).not.toBeNull();

      expect(repo.purgeBatch(cutoff, 2)).toBe(2);
      expect(repo.get('b')).toBeNull();
      expect(repo.get('c')).toBeNull();
      expect(repo.purgeBatch(cutoff, 2)).toBe(0);
      expect(repo.get('cutoff')).not.toBeNull();
    });
  });

  it('normalizes fractional keep values (Math.trunc)', () => {
    withRepo((repo) => {
      for (let day = 1; day <= 4; day += 1) {
        repo.save(makeSession(`s${String(day)}`, day));
      }

      expect(repo.pruneToCountBatch(2.9, 1)).toBe(1);
      expect(repo.list().map((session) => session.id)).toEqual(['s4', 's3', 's2']);
      expect(repo.pruneToCountBatch(2.9, 1)).toBe(1);
      expect(repo.list().map((session) => session.id)).toEqual(['s4', 's3']);
    });
  });

  it('enforces the hard batch ceiling without truncating a request', () => {
    withRepo((repo) => {
      const cutoff = new Date('2026-02-01T00:00:00.000Z');

      expect(repo.purgeBatch(cutoff)).toBe(0);
      expect(repo.purgeBatch(cutoff, MAX_SESSION_MAINTENANCE_BATCH_SIZE)).toBe(0);
      expect(() => repo.purgeBatch(cutoff, MAX_SESSION_MAINTENANCE_BATCH_SIZE + 1)).toThrow(
        /no greater than/,
      );
      expect(() => repo.pruneToCountBatch(1, 0)).toThrow(/positive integer/);
      expect(() => repo.pruneToCountBatch(1, 1.5)).toThrow(/positive integer/);
      expect(() => repo.pruneToCountBatch(1, Number.NaN)).toThrow(/positive integer/);
      expect(() => repo.pruneToCountBatch(0, 0)).toThrow(/positive integer/);
      expect(repo.pruneToCountBatch(0.5)).toBe(0);
    });
  });

  it('rejects invalid age cutoffs before entering persistence', () => {
    withRepo((repo) => {
      expect(() => repo.purgeBatch(new Date(Number.NaN), 1)).toThrow(
        /Invalid Session purge cutoff/,
      );
    });
  });

  it('uses one named write lock and transaction per batch', () => {
    withRepo((repo, datastore) => {
      repo.save(makeSession('a', 1));
      repo.save(makeSession('b', 2));
      const handle = requireDrizzleHandle(datastore);
      const lock = vi.spyOn(handle, 'withWriteLock');
      const transaction = vi.spyOn(handle, 'transaction');

      expect(repo.pruneToCountBatch(1, 1)).toBe(1);
      expect(lock).toHaveBeenCalledTimes(1);
      expect(lock).toHaveBeenCalledWith('session.prune_to_count_batch', expect.any(Function));
      expect(transaction).toHaveBeenCalledTimes(1);

      lock.mockClear();
      transaction.mockClear();
      expect(repo.purgeBatch(new Date('2027-01-01T00:00:00.000Z'), 1)).toBe(1);
      expect(lock).toHaveBeenCalledTimes(1);
      expect(lock).toHaveBeenCalledWith('session.purge_batch', expect.any(Function));
      expect(transaction).toHaveBeenCalledTimes(1);
    });
  });

  it('rolls back the complete bounded batch when its transaction fails', () => {
    withRepo((repo, datastore) => {
      repo.save(makeSession('a', 1));
      repo.save(makeSession('b', 2));
      const handle = requireDrizzleHandle(datastore);
      const originalTransaction = handle.transaction.bind(handle);
      vi.spyOn(handle, 'transaction').mockImplementation((fn) =>
        originalTransaction((tx) => {
          fn(tx);
          throw new Error('session retention transaction failed');
        }),
      );

      expect(() => repo.pruneToCountBatch(1, 1)).toThrow('session retention transaction failed');
      expect(repo.count()).toBe(2);
      expect(repo.get('a')).not.toBeNull();
      expect(repo.get('b')).not.toBeNull();
    });
  });
});
