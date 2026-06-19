/**
 * schema-version — derives the DB schema version this CLI supports, and owns the
 * version-guard math.
 *
 * The supported version is a **logical schema id** (`LOGICAL_SCHEMA_VERSION`),
 * independent of Drizzle journal entry count. Journal squashes renumber entries
 * without changing the on-disk schema shape, so equating `user_version` with
 * `entries.length` falsely blocks adopters after a squash (v0.1.0 stamped 14,
 * v0.1.1+ squashed to one entry). We stamp the logical id into SQLite's
 * `PRAGMA user_version` after a successful migrate and compare it on the next
 * open to detect a database written by a NEWER CLI (the downgrade direction
 * Drizzle's migrator cannot detect — see {@link isDbNewerThanCli}).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { logger } from '@opensip-cli/core';

/** Shape of the bits of Drizzle's `meta/_journal.json` we rely on. */
interface DrizzleJournal {
  readonly entries?: readonly unknown[];
}

/**
 * Logical schema identity — bump only on a breaking squash or incompatible
 * migration rewrite. Additive migrations do NOT increment this.
 */
export const LOGICAL_SCHEMA_VERSION = 2;

/**
 * Last `user_version` stamped by v0.1.0 (14 pre-squash journal entries).
 * DBs in the transitional range `1..LEGACY_PRE_SQUASH_MAX_USER_VERSION` are
 * adoptable by current builds even when ahead of {@link LOGICAL_SCHEMA_VERSION}
 * under the old journal-count scheme.
 */
export const LEGACY_PRE_SQUASH_MAX_USER_VERSION = 14;

/**
 * The DB schema version this CLI supports = {@link LOGICAL_SCHEMA_VERSION}.
 *
 * The migrations folder is still read to verify the bundle is intact; an
 * unreadable journal returns `undefined` so callers skip the version guard
 * (migrate() will surface the canonical failure).
 */
export function readSupportedDbVersion(migrationsFolder: string): number | undefined {
  const journalPath = join(migrationsFolder, 'meta', '_journal.json');
  try {
    const parsed = JSON.parse(readFileSync(journalPath, 'utf8')) as DrizzleJournal;
    if (!Array.isArray(parsed.entries) || parsed.entries.length === 0) return undefined;
    return LOGICAL_SCHEMA_VERSION;
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
 * True when the on-disk database was stamped by a CLI that knew a NEWER logical
 * schema than this one (`dbVersion > supportedVersion`) — i.e. the user
 * downgraded the CLI after a newer version advanced the schema.
 *
 * Legacy v0.1.0 files stamped with the pre-squash journal count (≤
 * {@link LEGACY_PRE_SQUASH_MAX_USER_VERSION}) are NOT treated as newer: they
 * are adopted via `migrate()` + re-stamp to the current logical version.
 *
 * The forward direction (`dbVersion <= supportedVersion`, including `0` on a
 * fresh or pre-guard database) is always safe.
 */
export function isDbNewerThanCli(dbVersion: number, supportedVersion: number): boolean {
  if (dbVersion <= supportedVersion) return false;
  // v0.1.0 stamped the pre-squash journal count (≤14), not the logical id.
  if (
    supportedVersion === LOGICAL_SCHEMA_VERSION &&
    dbVersion <= LEGACY_PRE_SQUASH_MAX_USER_VERSION
  ) {
    return false;
  }
  return true;
}
