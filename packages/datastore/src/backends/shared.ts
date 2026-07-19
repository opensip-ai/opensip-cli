import { logger, withFileLock } from '@opensip-cli/core';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import type {
  DataStoreLockContext,
  DatastoreCloseResult,
  DrizzleHandle,
  SqliteBackendHandle,
} from '../data-store.js';

/** Minimal native lifecycle surface, separated so close faults are unit-testable. */
export interface SqliteLifecycleConnection {
  readonly open: boolean;
  pragma(source: string): unknown;
  close(): void;
}

interface CheckpointOutcome {
  readonly checkpointed: boolean;
  readonly busy: boolean;
}

/** A failed or unreadable native state probe is not closure evidence. */
export function sqliteConnectionProvenClosed(sqlite: SqliteLifecycleConnection): boolean {
  try {
    return sqlite.open === false;
  } catch {
    // @swallow-ok an unreadable native state fails closed: it is never closure evidence.
    return false;
  }
}

function checkpointSqlite(sqlite: SqliteLifecycleConnection): CheckpointOutcome {
  try {
    const result: unknown = sqlite.pragma('wal_checkpoint(TRUNCATE)');
    const first: unknown = Array.isArray(result) && result.length === 1 ? result[0] : undefined;
    if (
      typeof first !== 'object' ||
      first === null ||
      !('busy' in first) ||
      !('log' in first) ||
      !('checkpointed' in first)
    ) {
      return { checkpointed: false, busy: false };
    }
    const row = first as Record<string, unknown>;
    if (
      !Number.isSafeInteger(row.busy) ||
      !Number.isSafeInteger(row.log) ||
      !Number.isSafeInteger(row.checkpointed) ||
      (row.busy as number) < 0 ||
      (row.log as number) < -1 ||
      (row.checkpointed as number) < -1
    ) {
      return { checkpointed: false, busy: false };
    }
    const busy = row.busy as number;
    return { checkpointed: busy === 0, busy: busy !== 0 };
  } catch {
    // The bounded result deliberately does not expose arbitrary native errors.
    return { checkpointed: false, busy: false };
  }
}

/**
 * Fold WAL contents into the main SQLite file and always attempt native close.
 *
 * This helper is shared by ordinary backend shutdown and explicit file
 * checkpointing so their WAL/close semantics cannot drift.
 */
export function checkpointAndCloseSqlite(sqlite: SqliteLifecycleConnection): DatastoreCloseResult {
  const checkpoint = checkpointSqlite(sqlite);

  try {
    sqlite.close();
  } catch {
    // @swallow-ok the native `open` state below is authoritative; the bounded
    // result records an unclosed handle without exposing arbitrary native detail.
  }

  const closed = sqliteConnectionProvenClosed(sqlite);
  if (checkpoint.checkpointed && closed) {
    return { checkpointed: true, closed: true };
  }
  if (!checkpoint.checkpointed && closed) {
    return {
      checkpointed: false,
      closed: true,
      reason: checkpoint.busy ? 'checkpoint-busy' : 'checkpoint-failed',
    };
  }
  if (checkpoint.checkpointed) {
    return {
      checkpointed: true,
      closed: false,
      reason: 'native-close-failed',
    };
  }
  return {
    checkpointed: false,
    closed: false,
    reason: 'checkpoint-and-close-failed',
  };
}

/** @throws {Error} When checkpointing or native connection closure was not proven. */
function throwCloseFailure(
  result: Exclude<DatastoreCloseResult, { checkpointed: true; closed: true }>,
): never {
  throw new Error(`SQLite datastore close did not complete cleanly (${result.reason})`);
}

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
  let closeResult: DatastoreCloseResult | undefined;

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
      const result = closeResult ?? checkpointAndCloseSqlite(sqlite);
      closeResult = result;
      if (!result.checkpointed || !result.closed) throwCloseFailure(result);
    },
    closeForLifecycle(): DatastoreCloseResult {
      closeResult ??= checkpointAndCloseSqlite(sqlite);
      return closeResult;
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
