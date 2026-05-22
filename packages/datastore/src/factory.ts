import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { openMemoryBackend } from './backends/memory.js';
import { openSqliteBackend } from './backends/sqlite.js';
import { DataStoreMigrationError } from './data-store.js';

import type { DataStore, DataStoreOpenOptions } from './data-store.js';

function defaultMigrationsFolder(): string {
  return join(fileURLToPath(new URL('.', import.meta.url)), '..', 'migrations');
}

export const DataStoreFactory = {
  open(opts: DataStoreOpenOptions & { migrationsFolder?: string }): DataStore {
    const datastore =
      opts.backend === 'memory'
        ? openMemoryBackend()
        : openSqliteBackend({ path: requireSqlitePath(opts) });
    const migrationsFolder = opts.migrationsFolder ?? defaultMigrationsFolder();
    try {
      migrate(datastore.db, { migrationsFolder });
    } catch (error) {
      datastore.close();
      const recoveryHint =
        opts.backend === 'sqlite' && opts.path
          ? `Schema migration failed; the local cache may be corrupted or from a future version. Delete \`${opts.path}\` to start fresh (cache will rebuild on next run; session history will be lost).`
          : 'Schema migration failed against the in-memory backend; this is likely a programming error.';
      throw new DataStoreMigrationError(recoveryHint, { cause: error });
    }
    return datastore;
  },
};

function requireSqlitePath(opts: DataStoreOpenOptions): string {
  if (!opts.path) {
    throw new Error('DataStoreFactory.open: SQLite backend requires a `path` option');
  }
  return opts.path;
}
