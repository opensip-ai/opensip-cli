/**
 * Regression tests for the close()-shadows-the-real-error bug: two throw sites
 * in factory.ts used to call the THROWING `close()` right before raising their
 * own error, so a failing close silently replaced the original
 * DataStoreVersionError / DataStoreMigrationError with a generic close-failure
 * Error. Both sites now use the non-throwing `closeForLifecycle()` first and
 * only fall back to `close()` (which may throw) when the native handle proves
 * genuinely unclosed — mirroring the sqlite migrate-failure path this package
 * already hardened (see version-guard.test.ts's "preserves the migration
 * error when a pinned reader makes the close checkpoint busy").
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DataStoreFactory, DataStoreMigrationError, DataStoreVersionError } from '../index.js';

import type * as MemoryBackendModule from '../backends/memory.js';
import type { DatastoreCloseResult, DrizzleDataStore } from '../data-store.js';
import type * as SchemaVersionModule from '../schema-version.js';

vi.mock('../schema-version.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SchemaVersionModule>();
  return {
    ...actual,
    // The first call is the early read-only probe (before the writable handle
    // opens); the second is the post-open re-check this bug fix covers. Lying
    // "false" then "true" reaches the second throw site deterministically
    // without needing a real cross-process version-stamp race.
    isDbNewerThanCli: vi.fn(),
  };
});

vi.mock('../backends/memory.js', async (importOriginal) => {
  const actual = await importOriginal<typeof MemoryBackendModule>();
  return {
    ...actual,
    openMemoryBackend: vi.fn(actual.openMemoryBackend),
  };
});

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ds-factory-close-shadow-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('DataStoreFactory.open — version-guard close does not shadow DataStoreVersionError', () => {
  it('throws DataStoreVersionError, not the close failure, when close only fails to checkpoint', async () => {
    const { isDbNewerThanCli } = await import('../schema-version.js');
    const mocked = vi.mocked(isDbNewerThanCli);
    mocked.mockReturnValueOnce(false); // early read-only probe: let it through
    mocked.mockReturnValueOnce(true); // post-open re-check: this is the bug site

    const path = join(tmp, 'race.sqlite');
    const seed = new Database(path);
    seed.pragma('journal_mode = WAL');
    seed.pragma('auto_vacuum = INCREMENTAL');
    seed.exec('VACUUM');
    seed.exec(
      "CREATE TABLE pin (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO pin(value) VALUES ('old')",
    );
    seed.close();

    // Pin the WAL at an old snapshot with an open reader, then extend the WAL
    // from a second writer so the handle factory.ts opens cannot checkpoint on
    // close (checkpoint-busy) even though native close itself succeeds.
    const reader = new Database(path);
    try {
      reader.exec('BEGIN');
      reader.prepare('SELECT * FROM pin').all();
      const writer = new Database(path);
      try {
        writer.prepare("INSERT INTO pin(value) VALUES ('new')").run();
      } finally {
        writer.close();
      }

      expect(() => DataStoreFactory.open({ backend: 'sqlite', path })).toThrow(
        DataStoreVersionError,
      );
    } finally {
      reader.exec('ROLLBACK');
      reader.close();
    }

    expect(mocked).toHaveBeenCalledTimes(2);
  });
});

/** A DrizzleDataStore stub whose close() throws but whose native handle is
 * already proven closed — the "secondary checkpoint failure" case the fix
 * must not let shadow the real error. */
function fakeMemoryDataStoreWithFailingClose(): DrizzleDataStore {
  return {
    db: {} as DrizzleDataStore['db'],
    close(): void {
      throw new Error('SQLite datastore close did not complete cleanly (checkpoint-busy)');
    },
    closeForLifecycle(): DatastoreCloseResult {
      return { checkpointed: false, closed: true, reason: 'checkpoint-busy' };
    },
    transaction<T>(): T {
      throw new Error('not implemented in this stub');
    },
    withWriteLock<T>(_operation: string, fn: () => T): T {
      return fn();
    },
  };
}

describe('DataStoreFactory.open — memory migrate-failure close does not shadow DataStoreMigrationError', () => {
  it('throws DataStoreMigrationError, not the close failure, when close only fails to checkpoint', async () => {
    const { openMemoryBackend } = await import('../backends/memory.js');
    vi.mocked(openMemoryBackend).mockReturnValueOnce(fakeMemoryDataStoreWithFailingClose());

    expect(() =>
      DataStoreFactory.open({
        backend: 'memory',
        migrationsFolder: '/nonexistent/path/that/does/not/exist',
      }),
    ).toThrow(DataStoreMigrationError);
  });
});
