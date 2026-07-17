import type { FileLockEvent, StateLockPolicy } from '@opensip-cli/core';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export type DrizzleHandle<TSchema extends Record<string, unknown> = Record<string, unknown>> =
  BetterSQLite3Database<TSchema>;

/** Lock context passed when opening a file-backed datastore (ADR-0075). */
export interface DataStoreLockContext {
  readonly policy: StateLockPolicy;
  readonly runId?: string;
  readonly command?: string;
  readonly cwdBasename?: string;
  readonly onLockEvent?: (event: FileLockEvent) => void;
}

/** Optional vacuum/size maintenance operations on a file-backed store. */
export interface DatastoreMaintenance {
  incrementalVacuum(): void;
  fullVacuum(): void;
  fileSizeBytes(): number;
}

/** Stable, bounded reasons returned when SQLite lifecycle shutdown is incomplete. */
export type DatastoreCloseFailureReason =
  'checkpoint-busy' | 'checkpoint-failed' | 'native-close-failed' | 'checkpoint-and-close-failed';

/**
 * Proof that a datastore checkpoint/close attempt did (or did not) leave the
 * native SQLite connection closed.
 *
 * `closed` is the authority-bearing field: callers that protect a runtime with
 * a lease must retain that lease unless this result proves `closed: true`.
 */
export type DatastoreCloseResult =
  | {
      readonly checkpointed: true;
      readonly closed: true;
    }
  | {
      readonly checkpointed: false;
      readonly closed: true;
      readonly reason: 'checkpoint-busy' | 'checkpoint-failed';
    }
  | {
      readonly checkpointed: true;
      readonly closed: false;
      readonly reason: 'native-close-failed';
    }
  | {
      readonly checkpointed: false;
      readonly closed: false;
      readonly reason: 'checkpoint-and-close-failed';
    };

/**
 * Host-owned persistence handle used by repositories and CLI bootstrap code.
 * It exposes lifecycle, maintenance, and serialized write-lock coordination
 * only. There is no raw query or transaction callback on this surface —
 * repositories that need atomic multi-statement work narrow to
 * {@link DrizzleDataStore} via `@opensip-cli/datastore/internal`.
 */
export interface DataStore<_TSchema extends Record<string, unknown> = Record<string, unknown>> {
  readonly maintenance?: DatastoreMaintenance;
  close(): void;
  /**
   * Close with an explicit proof result for host lifecycle coordination.
   *
   * Optional for compatibility with external/custom DataStore implementations;
   * every first-party backend implements it.
   */
  closeForLifecycle?(): DatastoreCloseResult;
  /** Serialize datastore-file writes (no-op for in-memory backends). */
  withWriteLock<T>(operation: string, fn: () => T): T;
}

/**
 * Persistence-layer handle that exposes the raw Drizzle DB and transaction
 * callback. Repository modules can narrow to this shape when they own the
 * table boundary; general consumers must stay on {@link DataStore}.
 *
 * Direct query/transaction calls must stay inside `src/persistence/`,
 * `session-store`, or `datastore`. Cross-module business code should go
 * through the owning repository/API; `restrict-raw-db-access` guards that
 * boundary.
 */
export interface DrizzleDataStore<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> extends DataStore<TSchema> {
  readonly db: DrizzleHandle<TSchema>;
  /** Multi-statement atomic work for owner repositories only. */
  transaction<T>(fn: (tx: DrizzleHandle<TSchema>) => T): T;
}

/**
 * A SQLite-backed {@link DrizzleDataStore} that also exposes its built-in
 * `PRAGMA user_version` schema-stamp. Internal to the datastore package — the
 * factory uses it to read/write the version guard before and after migrating.
 * General consumers stay on {@link DataStore} / {@link DrizzleDataStore}.
 */
export interface SqliteBackendHandle<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> extends DrizzleDataStore<TSchema> {
  /** First-party SQLite backends always expose an explicit lifecycle proof. */
  closeForLifecycle(): DatastoreCloseResult;
  /** Read SQLite's `PRAGMA user_version` (0 on a fresh or pre-guard database). */
  readUserVersion(): number;
  /** Write SQLite's `PRAGMA user_version` schema-stamp. */
  writeUserVersion(version: number): void;
}

/** Type guard for a {@link DrizzleDataStore} handle (db + transaction + close). */
export function isDrizzleDataStore(value: unknown): value is DrizzleDataStore {
  return (
    typeof value === 'object' &&
    value !== null &&
    'db' in value &&
    'transaction' in value &&
    typeof value.transaction === 'function' &&
    'close' in value &&
    typeof value.close === 'function'
  );
}

/**
 * Narrow a {@link DataStore} to a {@link DrizzleDataStore}, requiring the raw
 * Drizzle handle to be present. Exported only via `@opensip-cli/datastore/internal`
 * for sibling persistence packages — not part of the public barrel (ADR-0107).
 *
 * @throws {Error} when `datastore` is not Drizzle-backed (general callers should
 *   use repository APIs instead of the raw datastore handle).
 */
export function requireDrizzleHandle(datastore: DataStore): DrizzleDataStore {
  if (isDrizzleDataStore(datastore)) return datastore;
  throw new Error(
    'A Drizzle-backed DataStore is required for repository access. General callers should use repository APIs instead of the raw datastore handle.',
  );
}

/** Options for opening a {@link DataStore}: backend choice and optional file path. */
export interface DataStoreOpenOptions {
  backend: 'sqlite' | 'memory';
  path?: string;
  /** Write-lock policy for file-backed SQLite datastores. */
  lock?: DataStoreLockContext;
}

/** Thrown when a Drizzle schema migration fails to apply; carries the offending file name. */
export class DataStoreMigrationError extends Error {
  readonly migrationFile: string | undefined;

  constructor(message: string, options: { migrationFile?: string; cause?: unknown } = {}) {
    // Pass cause to super so it lands on the standard Error.cause slot
    // (ES2022). Don't redeclare the field — that would shadow it with a
    // writable class-field property and bypass native engine handling.
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DataStoreMigrationError';
    this.migrationFile = options.migrationFile;
  }
}

/** Inputs describing an incompatible (future) on-disk database. */
export interface DataStoreVersionMismatch {
  readonly path: string;
  /** The `user_version` stamp found on disk. */
  readonly dbVersion: number;
  /** The highest schema version this CLI supports. */
  readonly supportedVersion: number;
}

/**
 * Thrown when the on-disk SQLite cache was written by a NEWER opensip-cli than
 * the one now opening it (`dbVersion > supportedVersion`). Drizzle's migrator
 * cannot detect this direction — the older CLI's migrations are all a prefix of
 * what was applied, so `migrate()` would no-op and later queries would hit
 * missing/renamed columns with a confusing error. This guard fails fast instead,
 * with an actionable message symmetric to the config-schema "upgrade your CLI"
 * bailout. The `.runtime/` cache is disposable, so deleting it is offered as the
 * fallback for users who intend to stay on the older CLI.
 */
export class DataStoreVersionError extends Error {
  readonly path: string;
  readonly dbVersion: number;
  readonly supportedVersion: number;

  constructor(mismatch: DataStoreVersionMismatch) {
    super(formatVersionErrorMessage(mismatch));
    this.name = 'DataStoreVersionError';
    this.path = mismatch.path;
    this.dbVersion = mismatch.dbVersion;
    this.supportedVersion = mismatch.supportedVersion;
  }
}

function formatVersionErrorMessage(mismatch: DataStoreVersionMismatch): string {
  return [
    `This project's opensip-cli cache was written by a newer version of opensip-cli than this CLI supports.`,
    ``,
    `  Cache:          ${mismatch.path}`,
    `  Cache schema:   v${mismatch.dbVersion}`,
    `  CLI supports:   v${mismatch.supportedVersion}`,
    ``,
    `  Update your CLI to continue:`,
    `    curl -fsSL https://opensip.ai/cli/install.sh | bash`,
    ``,
    `  (Or delete ${mismatch.path} to discard the local cache and continue with`,
    `  this older CLI — session history will be lost; the cache rebuilds on next run.)`,
  ].join('\n');
}
