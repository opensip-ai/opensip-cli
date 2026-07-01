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

/** Public persistence handle: lifecycle plus transaction, but no raw query escape hatch. */
export interface DatastoreMaintenance {
  incrementalVacuum(): void;
  fullVacuum(): void;
  fileSizeBytes(): number;
}

/**
 * Host-owned persistence handle used by repositories and CLI bootstrap code.
 * It exposes lifecycle, transaction, and serialized write-lock primitives while
 * keeping raw database access behind narrower datastore-owned interfaces.
 */
export interface DataStore<TSchema extends Record<string, unknown> = Record<string, unknown>> {
  readonly maintenance?: DatastoreMaintenance;
  close(): void;
  transaction<T>(fn: (tx: DrizzleHandle<TSchema>) => T): T;
  /** Serialize datastore-file writes (no-op for in-memory backends). */
  withWriteLock<T>(operation: string, fn: () => T): T;
}

/**
 * Persistence-layer handle that exposes the raw Drizzle DB. Repository modules
 * can narrow to this shape when they own the table boundary; general consumers
 * should stay on {@link DataStore}.
 *
 * Direct query calls must stay inside `src/persistence/`, `session-store`, or
 * `datastore`. Cross-module business code should go through the owning
 * repository/API; `restrict-raw-db-access` guards that boundary.
 */
export interface DrizzleDataStore<
  TSchema extends Record<string, unknown> = Record<string, unknown>,
> extends DataStore<TSchema> {
  readonly db: DrizzleHandle<TSchema>;
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
