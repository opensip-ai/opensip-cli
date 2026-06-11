import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigurationError } from '@opensip-tools/core';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

import { openMemoryBackend } from './backends/memory.js';
import { openSqliteBackend } from './backends/sqlite.js';
import { DataStoreMigrationError, DataStoreVersionError } from './data-store.js';
import { isDbNewerThanCli, readSupportedDbVersion } from './schema-version.js';

import type { DataStoreOpenOptions, DrizzleDataStore } from './data-store.js';

function defaultMigrationsFolder(): string {
  return join(fileURLToPath(new URL('.', import.meta.url)), '..', 'migrations');
}

export const DataStoreFactory = {
  /**
   * Open a DataStore (SQLite or in-memory) and run pending migrations.
   *
   * For SQLite, a version guard runs first: if the file was stamped by a NEWER
   * CLI than this one (`PRAGMA user_version` ahead of the bundled migration
   * count), it throws {@link DataStoreVersionError} instead of letting Drizzle
   * silently no-op into a runtime column error. After a successful migrate, the
   * stamp is refreshed to this CLI's supported version.
   *
   * @throws {DataStoreVersionError} When the SQLite file was written by a newer
   *   opensip-tools than this CLI supports (the downgrade direction).
   * @throws {DataStoreMigrationError} When the SQLite file cannot be opened
   *   (corrupt header, missing parent directory, permission errors) or when
   *   running the migrations folder fails. The original cause is preserved
   *   via the `cause` field.
   */
  open(opts: DataStoreOpenOptions & { migrationsFolder?: string }): DrizzleDataStore {
    const migrationsFolder = opts.migrationsFolder ?? defaultMigrationsFolder();

    if (opts.backend === 'memory') {
      return openAndMigrate(opts, migrationsFolder, () => openMemoryBackend());
    }

    const path = requireSqlitePath(opts);
    let handle;
    try {
      handle = openSqliteBackend({ path });
    } catch (error) {
      // Corrupted file (bad SQLite header), missing dir, permission errors, etc.
      throw new DataStoreMigrationError(openFailureMessage(opts), { cause: error });
    }

    // `undefined` (unreadable journal) means "skip the guard" — migrate() reads
    // the same journal and will surface the canonical failure loudly.
    const supportedVersion = readSupportedDbVersion(migrationsFolder);
    if (supportedVersion !== undefined) {
      const dbVersion = handle.readUserVersion();
      if (isDbNewerThanCli(dbVersion, supportedVersion)) {
        handle.close();
        throw new DataStoreVersionError({ path, dbVersion, supportedVersion });
      }
    }

    try {
      migrate(handle.db, { migrationsFolder });
    } catch (error) {
      handle.close();
      throw new DataStoreMigrationError(migrateFailureMessage(opts), { cause: error });
    }

    // Re-stamp on every successful open: a fresh (0) or pre-guard "legacy" DB
    // gets adopted to the current version; an already-current DB is a no-op write.
    if (supportedVersion !== undefined) handle.writeUserVersion(supportedVersion);
    return handle;
  },
};

/**
 * Open a backend and run migrations, mapping both failures to
 * {@link DataStoreMigrationError}. Used for the in-memory path (which needs no
 * version guard — it is ephemeral) and shared message handling.
 *
 * @throws {DataStoreMigrationError} When the backend cannot be opened or the
 *   migrations folder fails to apply; the original cause is preserved.
 */
function openAndMigrate(
  opts: DataStoreOpenOptions,
  migrationsFolder: string,
  openBackend: () => DrizzleDataStore,
): DrizzleDataStore {
  let datastore: DrizzleDataStore;
  try {
    datastore = openBackend();
  } catch (error) {
    throw new DataStoreMigrationError(openFailureMessage(opts), { cause: error });
  }
  try {
    migrate(datastore.db, { migrationsFolder });
  } catch (error) {
    datastore.close();
    throw new DataStoreMigrationError(migrateFailureMessage(opts), { cause: error });
  }
  return datastore;
}

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
    throw new ConfigurationError('DataStoreFactory.open: SQLite backend requires a `path` option', {
      code: 'CONFIGURATION.DATASTORE.MISSING_PATH',
    });
  }
  return opts.path;
}
