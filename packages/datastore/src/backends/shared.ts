import { logger, withFileLock } from '@opensip-cli/core';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import type { DataStoreLockContext, DrizzleHandle, SqliteBackendHandle } from '../data-store.js';

export function buildSqliteDataStore(
  dbPath: string,
  lock?: DataStoreLockContext,
): SqliteBackendHandle {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  // Single connection per process, but two concurrent `opensip` invocations can
  // contend on the same project DB. Wait briefly instead of throwing SQLITE_BUSY.
  sqlite.pragma('busy_timeout = 5000');
  const isMemory = dbPath === ':memory:';
  if (!isMemory) {
    try {
      const autoVacuum = Number(sqlite.pragma('auto_vacuum', { simple: true }));
      if (autoVacuum !== 2) {
        sqlite.pragma('auto_vacuum = INCREMENTAL');
        sqlite.exec('VACUUM');
        logger.info({
          evt: 'datastore.autovacuum.converted',
          module: 'datastore:sqlite',
          path: dbPath,
          previousMode: autoVacuum,
        });
      }
    } catch (error) {
      logger.warn({
        evt: 'datastore.autovacuum.conversion_failed',
        module: 'datastore:sqlite',
        path: dbPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const db: DrizzleHandle = drizzle(sqlite);
  let closed = false;

  const lockPath = isMemory ? undefined : `${dbPath}.write.lock`;

  const withWriteLock = <T>(operation: string, fn: () => T): T => {
    if (!lockPath || !lock) return fn();
    return withFileLock(
      lockPath,
      {
        policy: lock.policy,
        resource: 'datastore',
        operation,
        runId: lock.runId,
        command: lock.command,
        cwdBasename: lock.cwdBasename,
        onEvent: lock.onLockEvent,
      },
      fn,
    );
  };

  return {
    db,
    close(): void {
      if (closed) return;
      // Fold the WAL back into the main DB and truncate the -wal/-shm sidecars so
      // they don't grow unbounded across runs (better-sqlite3 close() checkpoints,
      // but TRUNCATE also shrinks the file on disk).
      sqlite.pragma('wal_checkpoint(TRUNCATE)');
      sqlite.close();
      closed = true;
    },
    transaction<T>(fn: (tx: DrizzleHandle) => T): T {
      return db.transaction(fn);
    },
    withWriteLock,
    readUserVersion(): number {
      // `{ simple: true }` returns the scalar (0 on a fresh DB) rather than a row array.
      return Number(sqlite.pragma('user_version', { simple: true }));
    },
    writeUserVersion(version: number): void {
      // PRAGMA does not accept bound parameters; the value is an integer we own,
      // so interpolating it is safe (and `Number(...)`-guarded by the type).
      sqlite.pragma(`user_version = ${version}`);
    },
    ...(isMemory
      ? {}
      : {
          maintenance: {
            incrementalVacuum(): void {
              sqlite.pragma('incremental_vacuum');
            },
            fullVacuum(): void {
              sqlite.exec('VACUUM');
            },
            fileSizeBytes(): number {
              const pages = Number(sqlite.pragma('page_count', { simple: true }));
              const pageSize = Number(sqlite.pragma('page_size', { simple: true }));
              return pages * pageSize;
            },
          },
        }),
  };
}
