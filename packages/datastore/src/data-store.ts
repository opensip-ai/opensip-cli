import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

export type DrizzleHandle<TSchema extends Record<string, unknown> = Record<string, unknown>> =
  BetterSQLite3Database<TSchema>;

export interface DataStore<TSchema extends Record<string, unknown> = Record<string, unknown>> {
  readonly db: DrizzleHandle<TSchema>;
  close(): void;
  transaction<T>(fn: (tx: DrizzleHandle<TSchema>) => T): T;
}

export interface DataStoreOpenOptions {
  backend: 'sqlite' | 'memory';
  path?: string;
}

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
