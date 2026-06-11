import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export type DrizzleHandle<TSchema extends Record<string, unknown> = Record<string, unknown>> =
  BetterSQLite3Database<TSchema>;

/**
 * Persistence handle exposing a typed Drizzle DB and a transaction runner.
 *
 * `db` is intentionally available to persistence-owned packages, but direct
 * query calls must stay inside `src/persistence/`, `session-store`, or
 * `datastore`. Cross-module business code should go through the owning
 * repository/API; `restrict-raw-db-access` guards that boundary.
 */
export interface DataStore<TSchema extends Record<string, unknown> = Record<string, unknown>> {
  readonly db: DrizzleHandle<TSchema>;
  close(): void;
  transaction<T>(fn: (tx: DrizzleHandle<TSchema>) => T): T;
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
