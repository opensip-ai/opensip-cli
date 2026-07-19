/**
 * @fileoverview Lock-serialized checkpoint and native-close proof for an
 * existing SQLite file.
 */

import { withFileLock } from '@opensip-cli/core';
import Database from 'better-sqlite3';

import {
  checkpointAndCloseSqlite,
  sqliteConnectionProvenClosed,
  type SqliteLifecycleConnection,
} from './backends/shared.js';

import type { DataStoreLockContext, DatastoreCloseResult } from './data-store.js';

/** @internal
 * Optional maintenance authority for callers that already hold a stronger
 * lifecycle lease. Ordinary datastore callers retain the adjacent lock path.
 */
export interface SqliteCheckpointOptions {
  /** Stable, caller-owned lock location outside a runtime tree being moved. */
  readonly lockPath?: string;
  /** Runs inside the acquired lock immediately before the native open. */
  readonly beforeOpen?: () => void;
  /** Runs after native open and before checkpointing; deterministic fault seam. */
  readonly afterOpen?: () => void;
  /** Reasserts authority after the fault seam and immediately before checkpoint. */
  readonly beforeCheckpoint?: () => void;
  /** Runs inside the acquired lock after checkpoint and native close. */
  readonly afterClose?: () => void;
}

/** @internal Native-open seam used only by datastore-owned lifecycle tests. */
export interface SqliteCheckpointDependencies {
  readonly openDatabase: (path: string) => SqliteLifecycleConnection;
}

class SqliteCheckpointLifecycleError extends Error {
  constructor(readonly result: DatastoreCloseResult) {
    super('Unable to open the existing SQLite file for checkpointing');
    this.name = 'SqliteCheckpointLifecycleError';
  }
}

/**
 * Recover the bounded native-close proof from a checkpoint failure.
 *
 * Callers must treat `undefined` conservatively: only this datastore-owned
 * error proves whether a native handle was closed.
 */
export function sqliteCheckpointFailureResult(error: unknown): DatastoreCloseResult | undefined {
  return error instanceof SqliteCheckpointLifecycleError ? error.result : undefined;
}

function failedCheckpointResult(closed: boolean): DatastoreCloseResult {
  return closed
    ? { checkpointed: false, closed: true, reason: 'checkpoint-failed' }
    : {
        checkpointed: false,
        closed: false,
        reason: 'checkpoint-and-close-failed',
      };
}

function closeWithoutCheckpoint(sqlite: SqliteLifecycleConnection): DatastoreCloseResult {
  try {
    sqlite.close();
  } catch {
    // @swallow-ok the native `open` state below remains the authority-bearing
    // proof, and failedCheckpointResult preserves an unclosed outcome.
  }
  return failedCheckpointResult(sqliteConnectionProvenClosed(sqlite));
}

const DEFAULT_CHECKPOINT_DEPENDENCIES: SqliteCheckpointDependencies = Object.freeze({
  openDatabase: (path: string) => new Database(path, { fileMustExist: true }),
});

/**
 * Checkpoint and close an existing SQLite file while serialized by its normal
 * datastore write lock.
 *
 * The caller must already hold the runtime's exclusive maintenance lease. This
 * function uses `fileMustExist`, does not migrate or vacuum, and reports whether
 * the native connection is proven closed.
 */
export function checkpointSqliteFile(
  path: string,
  lockContext: DataStoreLockContext,
  options: SqliteCheckpointOptions = {},
): DatastoreCloseResult {
  return checkpointSqliteFileWithDependencies(
    path,
    lockContext,
    options,
    DEFAULT_CHECKPOINT_DEPENDENCIES,
  );
}

/**
 * @internal Use {@link checkpointSqliteFile} outside datastore tests.
 * @throws {SqliteCheckpointLifecycleError} When lock, open, checkpoint, hook, or close fails.
 */
export function checkpointSqliteFileWithDependencies(
  path: string,
  lockContext: DataStoreLockContext,
  options: SqliteCheckpointOptions,
  dependencies: SqliteCheckpointDependencies,
): DatastoreCloseResult {
  try {
    return withFileLock(
      options.lockPath ?? `${path}.write.lock`,
      {
        policy: lockContext.policy,
        resource: 'datastore',
        operation: 'datastore.checkpoint',
        runId: lockContext.runId,
        command: lockContext.command,
        cwdBasename: lockContext.cwdBasename,
        onEvent: lockContext.onLockEvent,
      },
      () => {
        try {
          options.beforeOpen?.();
        } catch {
          throw new SqliteCheckpointLifecycleError(failedCheckpointResult(true));
        }

        let sqlite: SqliteLifecycleConnection;
        try {
          sqlite = dependencies.openDatabase(path);
        } catch {
          throw new SqliteCheckpointLifecycleError(failedCheckpointResult(true));
        }

        try {
          options.afterOpen?.();
          options.beforeCheckpoint?.();
        } catch {
          throw new SqliteCheckpointLifecycleError(closeWithoutCheckpoint(sqlite));
        }

        let result: DatastoreCloseResult;
        try {
          result = checkpointAndCloseSqlite(sqlite);
        } catch {
          throw new SqliteCheckpointLifecycleError(closeWithoutCheckpoint(sqlite));
        }
        try {
          options.afterClose?.();
        } catch {
          throw new SqliteCheckpointLifecycleError(result);
        }
        return result;
      },
    );
  } catch (error) {
    if (error instanceof SqliteCheckpointLifecycleError) throw error;
    // File-lock/open failures before a native handle is returned are safe to
    // release. Every post-open failure above carries its own close proof.
    throw new SqliteCheckpointLifecycleError(failedCheckpointResult(true));
  }
}
