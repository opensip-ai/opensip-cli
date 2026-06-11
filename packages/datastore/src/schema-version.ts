/**
 * schema-version — derives the DB schema version this CLI supports from the
 * bundled Drizzle migration journal, and owns the version-guard math.
 *
 * The "supported version" is simply the number of migrations this build ships
 * (the journal's entry count). It is monotonic: every new migration increments
 * it automatically, so there is NO constant to hand-bump when a migration is
 * added. We stamp this integer into the SQLite header (`PRAGMA user_version`)
 * after a successful migrate, and compare it on the next open to detect a
 * database written by a NEWER CLI than the one now opening it (the downgrade
 * direction Drizzle's own migrator cannot detect — see {@link isDbNewerThanCli}).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { logger } from '@opensip-tools/core';

/** Shape of the bits of Drizzle's `meta/_journal.json` we rely on. */
interface DrizzleJournal {
  readonly entries?: readonly unknown[];
}

/**
 * The DB schema version this CLI supports = the count of migrations it bundles.
 *
 * Returns `undefined` when the bundled journal cannot be read or parsed (a
 * broken install). Callers treat `undefined` as "skip the version guard": the
 * subsequent `migrate()` reads the same journal and will surface the canonical
 * {@link DataStoreMigrationError} loudly, so skipping here hides nothing — it
 * just declines to invent a version we cannot determine. We still warn so the
 * anomaly is observable rather than silent.
 */
export function readSupportedDbVersion(migrationsFolder: string): number | undefined {
  const journalPath = join(migrationsFolder, 'meta', '_journal.json');
  try {
    const parsed = JSON.parse(readFileSync(journalPath, 'utf8')) as DrizzleJournal;
    return Array.isArray(parsed.entries) ? parsed.entries.length : undefined;
  } catch (error) {
    logger.warn({
      evt: 'datastore.schema-version.journal-unreadable',
      module: 'datastore:schema-version',
      journalPath,
      err: error,
    });
    return undefined;
  }
}

/**
 * True when the on-disk database was stamped by a CLI that knew MORE migrations
 * than this one (`dbVersion > supportedVersion`) — i.e. the user downgraded the
 * CLI after a newer version advanced the schema.
 *
 * The forward direction (`dbVersion <= supportedVersion`, including the `0` of a
 * fresh or pre-guard "legacy" database) is always safe: Drizzle's migrator
 * applies any pending migrations and we re-stamp afterward. Only the future
 * database is blocked.
 */
export function isDbNewerThanCli(dbVersion: number, supportedVersion: number): boolean {
  return dbVersion > supportedVersion;
}
