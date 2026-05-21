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
  readonly cause: unknown;

  constructor(message: string, options: { migrationFile?: string; cause?: unknown } = {}) {
    super(message);
    this.name = 'DataStoreMigrationError';
    this.migrationFile = options.migrationFile;
    this.cause = options.cause;
  }
}
