import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export type DrizzleHandle<TSchema extends Record<string, unknown> = Record<string, unknown>> =
  BetterSQLite3Database<TSchema>;

/** Public persistence handle: lifecycle plus transaction, but no raw query escape hatch. */
export interface DataStore<TSchema extends Record<string, unknown> = Record<string, unknown>> {
  close(): void;
  transaction<T>(fn: (tx: DrizzleHandle<TSchema>) => T): T;
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
 * Drizzle handle to be present.
 *
 * @throws {Error} when `datastore` is not Drizzle-backed (general callers should
 *   use repository APIs instead of the raw datastore handle).
 */
export function requireDrizzleDataStore(datastore: DataStore): DrizzleDataStore {
  if (isDrizzleDataStore(datastore)) return datastore;
  throw new Error(
    'A Drizzle-backed DataStore is required for repository access. General callers should use repository APIs instead of the raw datastore handle.',
  );
}

/** Options for opening a {@link DataStore}: backend choice and optional file path. */
export interface DataStoreOpenOptions {
  backend: 'sqlite' | 'memory';
  path?: string;
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
