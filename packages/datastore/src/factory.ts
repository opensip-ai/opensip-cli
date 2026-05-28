import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigurationError } from '@opensip-tools/core';
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
    let datastore: DataStore;
    try {
      datastore =
        opts.backend === 'memory'
          ? openMemoryBackend()
          : openSqliteBackend({ path: requireSqlitePath(opts) });
    } catch (error) {
      // Corrupted file (bad SQLite header), missing dir, permission errors, etc.
      throw new DataStoreMigrationError(openFailureMessage(opts), { cause: error });
    }

    const migrationsFolder = opts.migrationsFolder ?? defaultMigrationsFolder();
    try {
      migrate(datastore.db, { migrationsFolder });
    } catch (error) {
      datastore.close();
      throw new DataStoreMigrationError(migrateFailureMessage(opts), { cause: error });
    }
    return datastore;
  },
};

function openFailureMessage(opts: DataStoreOpenOptions): string {
  if (opts.backend === 'sqlite' && opts.path) {
    return `Failed to open SQLite data store at \`${opts.path}\` — the file may be corrupted, missing permissions, or in a non-writable directory. Delete \`${opts.path}\` to start fresh (cache will rebuild on next run; session history will be lost).`;
  }
  return 'Failed to open in-memory data store; this is likely a programming error.';
}

function migrateFailureMessage(opts: DataStoreOpenOptions): string {
  if (opts.backend === 'sqlite' && opts.path) {
    return `Schema migration failed against \`${opts.path}\`; the local cache may be from an incompatible version. Delete \`${opts.path}\` to start fresh (cache will rebuild on next run; session history will be lost).`;
  }
  return 'Schema migration failed against the in-memory backend; this is likely a programming error.';
}

function requireSqlitePath(opts: DataStoreOpenOptions): string {
  if (!opts.path) {
    throw new ConfigurationError(
      'DataStoreFactory.open: SQLite backend requires a `path` option',
      { code: 'CONFIGURATION.DATASTORE.MISSING_PATH' },
    );
  }
  return opts.path;
}
