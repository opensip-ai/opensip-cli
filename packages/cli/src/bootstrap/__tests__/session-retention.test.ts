import { cliConfigSchema } from '@opensip-cli/config';
import {
  DataStoreFactory,
  type DataStore,
  type DatastoreMaintenance,
} from '@opensip-cli/datastore';
import { SessionRepo } from '@opensip-cli/session-store';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SESSION_RETENTION_KEEP,
  DEFAULT_SESSION_RETENTION_MAX_AGE_DAYS,
  DEFAULT_SESSION_RETENTION_MAX_SIZE_MB,
  enforceSessionRetention,
  resolveSessionRetentionPolicy,
} from '../session-retention.js';

import type { StoredSession } from '@opensip-cli/contracts';
import type { Logger } from '@opensip-cli/core';

function logger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

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

function withMaintenance(datastore: DataStore, maintenance: DatastoreMaintenance): DataStore {
  Object.defineProperty(datastore, 'maintenance', {
    value: maintenance,
    configurable: true,
  });
  return datastore;
}

function failWriteLock(datastore: DataStore, operation: string, error: unknown): void {
  const original = datastore.withWriteLock.bind(datastore);
  Object.defineProperty(datastore, 'withWriteLock', {
    value: <T>(op: string, fn: () => T): T => {
      if (op === operation) throw error;
      return original(op, fn);
    },
    configurable: true,
  });
}

describe('session retention defaults', () => {
  it('keeps CLI constants in sync with the config schema defaults', () => {
    const parsed = cliConfigSchema.shape.sessions.safeParse({});
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('expected sessions defaults to parse');
    expect(parsed.data).toEqual({
      keep: DEFAULT_SESSION_RETENTION_KEEP,
      maxAgeDays: DEFAULT_SESSION_RETENTION_MAX_AGE_DAYS,
      maxSizeMb: DEFAULT_SESSION_RETENTION_MAX_SIZE_MB,
    });
    expect(resolveSessionRetentionPolicy()).toEqual(parsed.data);
  });

  it('normalizes configured values before enforcing retention', () => {
    expect(
      resolveSessionRetentionPolicy({
        keep: 3.8,
        maxAgeDays: -1,
        maxSizeMb: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({
      keep: 3,
      maxAgeDays: DEFAULT_SESSION_RETENTION_MAX_AGE_DAYS,
      maxSizeMb: DEFAULT_SESSION_RETENTION_MAX_SIZE_MB,
    });
  });
});

describe('enforceSessionRetention', () => {
  it('applies count and age pruning without requiring maintenance capability', () => {
    withRepo((repo, datastore) => {
      for (let i = 0; i < 6; i += 1) {
        repo.save(makeSession(`s${i}`, i + 1));
      }

      enforceSessionRetention(
        datastore,
        { keep: 4, maxAgeDays: 2, maxSizeMb: 0 },
        { now: Date.parse('2026-01-07T00:00:00.000Z'), logger: logger() },
      );

      expect(repo.list().map((session) => session.id)).toEqual(['s5', 's4']);
    });
  });

  it('gates count pruning when the row count is already within keep', () => {
    withRepo((repo, datastore) => {
      repo.save(makeSession('a', 1));
      const incrementalVacuum = vi.fn();
      withMaintenance(datastore, {
        incrementalVacuum,
        fullVacuum: vi.fn(),
        fileSizeBytes: vi.fn(() => 1),
      });

      enforceSessionRetention(
        datastore,
        { keep: 5, maxAgeDays: 0, maxSizeMb: 1 },
        { now: Date.parse('2026-01-02T00:00:00.000Z'), logger: logger() },
      );

      expect(repo.count()).toBe(1);
      expect(incrementalVacuum).not.toHaveBeenCalled();
    });
  });

  it('warns on oversize and bounds full VACUUM to the safety-net passes', () => {
    withRepo((repo, datastore) => {
      for (let i = 0; i < 5; i += 1) {
        repo.save(makeSession(`s${i}`, i + 1));
      }
      const warn = vi.fn();
      const log: Logger = { ...logger(), warn };
      const fullVacuum = vi.fn();
      withMaintenance(datastore, {
        incrementalVacuum: vi.fn(),
        fullVacuum,
        fileSizeBytes: vi.fn(() => 3 * 1024 * 1024),
      });

      enforceSessionRetention(
        datastore,
        { keep: 4, maxAgeDays: 0, maxSizeMb: 1 },
        { now: Date.parse('2026-01-08T00:00:00.000Z'), logger: log },
      );

      expect(fullVacuum).toHaveBeenCalledTimes(2);
      expect(repo.count()).toBe(2);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ evt: 'session.retention.oversize.warn' }),
      );
    });
  });

  it('logs retention failures when maintenance size probes fail', () => {
    withRepo((repo, datastore) => {
      repo.save(makeSession('a', 1));
      const warn = vi.fn();
      const info = vi.fn();
      const log: Logger = { ...logger(), info, warn };
      const fullVacuum = vi.fn();
      let sizeCalls = 0;
      const statError: unknown = 'stat unavailable';
      withMaintenance(datastore, {
        incrementalVacuum: vi.fn(),
        fullVacuum,
        fileSizeBytes: vi.fn(() => {
          sizeCalls += 1;
          if (sizeCalls === 1) return 3 * 1024 * 1024;
          throw statError;
        }),
      });

      expect(() =>
        enforceSessionRetention(
          datastore,
          { keep: 5, maxAgeDays: 0, maxSizeMb: 1 },
          { now: Date.parse('2026-01-02T00:00:00.000Z'), logger: log },
        ),
      ).not.toThrow();

      expect(fullVacuum).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          evt: 'session.retention.failed',
          operation: 'session.retention.file_size',
          error: 'stat unavailable',
        }),
      );
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          evt: 'session.retention.vacuumed',
          beforeBytes: null,
          afterBytes: null,
        }),
      );
    });
  });

  it('does not aggressively prune when full VACUUM brings size under the limit', () => {
    withRepo((repo, datastore) => {
      for (let i = 0; i < 3; i += 1) {
        repo.save(makeSession(`s${i}`, i + 1));
      }
      const fullVacuum = vi.fn();
      const fileSizeBytes = vi
        .fn()
        .mockReturnValueOnce(3 * 1024 * 1024)
        .mockReturnValueOnce(3 * 1024 * 1024)
        .mockReturnValueOnce(1024)
        .mockReturnValueOnce(1024);
      withMaintenance(datastore, {
        incrementalVacuum: vi.fn(),
        fullVacuum,
        fileSizeBytes,
      });

      enforceSessionRetention(
        datastore,
        { keep: 4, maxAgeDays: 0, maxSizeMb: 1 },
        { now: Date.parse('2026-01-08T00:00:00.000Z'), logger: logger() },
      );

      expect(fullVacuum).toHaveBeenCalledTimes(1);
      expect(repo.count()).toBe(3);
    });
  });

  it('skips aggressive size pruning when already at the aggressive keep count', () => {
    withRepo((repo, datastore) => {
      repo.save(makeSession('a', 1));
      repo.save(makeSession('b', 2));
      const fullVacuum = vi.fn();
      withMaintenance(datastore, {
        incrementalVacuum: vi.fn(),
        fullVacuum,
        fileSizeBytes: vi.fn(() => 3 * 1024 * 1024),
      });

      enforceSessionRetention(
        datastore,
        { keep: 4, maxAgeDays: 0, maxSizeMb: 1 },
        { now: Date.parse('2026-01-08T00:00:00.000Z'), logger: logger() },
      );

      expect(fullVacuum).toHaveBeenCalledTimes(1);
      expect(repo.count()).toBe(2);
    });
  });

  it('swallows incremental reclaim lock failures after pruning', () => {
    withRepo((repo, datastore) => {
      for (let i = 0; i < 3; i += 1) {
        repo.save(makeSession(`s${i}`, i + 1));
      }
      const warn = vi.fn();
      const log: Logger = { ...logger(), warn };
      const incrementalVacuum = vi.fn();
      withMaintenance(datastore, {
        incrementalVacuum,
        fullVacuum: vi.fn(),
        fileSizeBytes: vi.fn(() => 1),
      });
      failWriteLock(datastore, 'session.retention.incremental_vacuum', 'lock denied');

      expect(() =>
        enforceSessionRetention(
          datastore,
          { keep: 1, maxAgeDays: 0, maxSizeMb: 1 },
          { now: Date.parse('2026-01-08T00:00:00.000Z'), logger: log },
        ),
      ).not.toThrow();

      expect(repo.count()).toBe(1);
      expect(incrementalVacuum).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({
          evt: 'session.retention.failed',
          operation: 'session.retention.incremental_vacuum',
          error: 'lock denied',
        }),
      );
    });
  });

  it('swallows reclaim failures and logs a retention failure', () => {
    withRepo((repo, datastore) => {
      repo.save(makeSession('a', 1));
      const warn = vi.fn();
      const log: Logger = { ...logger(), warn };
      withMaintenance(datastore, {
        incrementalVacuum: vi.fn(),
        fullVacuum: vi.fn(() => {
          throw new Error('ENOSPC');
        }),
        fileSizeBytes: vi.fn(() => 3 * 1024 * 1024),
      });

      expect(() =>
        enforceSessionRetention(
          datastore,
          { keep: 5, maxAgeDays: 0, maxSizeMb: 1 },
          { now: Date.parse('2026-01-02T00:00:00.000Z'), logger: log },
        ),
      ).not.toThrow();
      expect(repo.count()).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ evt: 'session.retention.failed' }),
      );
    });
  });
});
