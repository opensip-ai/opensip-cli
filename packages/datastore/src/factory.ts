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
   *   (corrupt header, missing parent directory, permission errors), when the
   *   native `better-sqlite3` binding fails to load (an ABI mismatch — the file
   *   is fine, the addon was built for a different Node.js version), or when
   *   running the migrations folder fails. The original cause is preserved via
   *   the `cause` field; the message distinguishes the binding case so callers
   *   are not told to delete a healthy data store.
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
      // Corrupted file (bad SQLite header), missing dir, permission errors, or a
      // native-binding ABI mismatch (better-sqlite3 built for another Node.js).
      throw new DataStoreMigrationError(openFailureMessage(opts, error), { cause: error });
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
    throw new DataStoreMigrationError(openFailureMessage(opts, error), { cause: error });
  }
  try {
    migrate(datastore.db, { migrationsFolder });
  } catch (error) {
    datastore.close();
    throw new DataStoreMigrationError(migrateFailureMessage(opts), { cause: error });
  }
  return datastore;
}

/**
 * Detect a native-binding load failure: `better-sqlite3`'s compiled addon was
 * built for a different Node.js ABI than the one now running (e.g. the binding
 * was compiled under Node 22 and the CLI is run under Node 24). This is NOT a
 * data problem — the SQLite file is intact and must not be deleted; the fix is
 * to rebuild the native module for the current Node.js.
 *
 * Identified by the Node loader's `ERR_DLOPEN_FAILED` code or the
 * `NODE_MODULE_VERSION` / "compiled against a different Node.js version" text,
 * scanned across the whole `cause` chain (the error may be wrapped).
 */
export function isNativeBindingError(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if ((current as { code?: unknown }).code === 'ERR_DLOPEN_FAILED') return true;
    if (
      /NODE_MODULE_VERSION|compiled against a different Node\.js version/i.test(current.message)
    ) {
      return true;
    }
  }
  return false;
}

export function openFailureMessage(opts: DataStoreOpenOptions, error: unknown): string {
  // A native-binding ABI mismatch is not a corrupt/missing file — telling the
  // user to delete the data store would destroy healthy session history for no
  // reason. Steer them to rebuild the addon instead, regardless of backend.
  if (isNativeBindingError(error)) {
    return `Failed to load the native SQLite module (better-sqlite3): its compiled binding was built for a different Node.js version than the one now running. Your data store is NOT corrupt — do not delete it. Rebuild the native module for your current Node.js with \`pnpm rebuild better-sqlite3\`, and run opensip-tools on the Node.js version this project targets (see \`.nvmrc\` / the package.json \`engines\` field).`;
  }
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
