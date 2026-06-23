/**
 * schema-version — derives the DB schema version this CLI supports, and owns the
 * version-guard math.
 *
 * The supported version is a monotonic schema stamp:
 *
 *   `SCHEMA_VERSION_OFFSET + bundledJournalEntryCount`
 *
 * Additive migrations therefore advance the stamp automatically, while a future
 * journal squash preserves monotonicity by updating the offset to account for
 * the entries removed by the squash. This avoids the v0.1.0 bug where a DB
 * stamped with 14 pre-squash entries was later compared against a squashed
 * `entries.length === 1`. We stamp the monotonic id into SQLite's
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
 * Last `user_version` stamped by v0.1.0 (14 pre-squash journal entries).
 * DBs in the transitional range `1..LEGACY_PRE_SQUASH_MAX_USER_VERSION` are
 * adoptable by current builds under the old journal-count scheme.
 */
export const LEGACY_PRE_SQUASH_MAX_USER_VERSION = 14;

/**
 * Offset for the first squashed journal.
 *
 * Current support calculation is:
 *
 *   `SCHEMA_VERSION_OFFSET + entries.length`
 *
 * Additive migrations increase `entries.length` and therefore increase the DB
 * stamp. If the journal is squashed again, update this offset so the result
 * remains equal to the pre-squash supported version.
 */
export const SCHEMA_VERSION_OFFSET = LEGACY_PRE_SQUASH_MAX_USER_VERSION;

/**
 * Current logical schema stamp for the bundled post-squash journal. Three entries:
 * the squash (0000) + the `stable_id` drop (0001) + `run_outcome` (0002). Bump
 * this in lockstep with the bundled journal entry count (or fold into the offset
 * on the next squash).
 */
export const LOGICAL_SCHEMA_VERSION = SCHEMA_VERSION_OFFSET + 3;

/**
 * The DB schema version this CLI supports = offset + bundled journal entries.
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
    return SCHEMA_VERSION_OFFSET + parsed.entries.length;
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
 * True when the on-disk database was stamped by a CLI that knew a NEWER schema
 * than this one (`dbVersion > supportedVersion`) — i.e. the user downgraded the
 * CLI after a newer version advanced the schema. Only this future direction is
 * blocked; the forward direction (`dbVersion <= supportedVersion`, including `0`
 * on a fresh or pre-guard database) is always safe — Drizzle's migrator applies
 * any pending migrations and the caller re-stamps afterward.
 *
 * No legacy special-case is required. {@link SCHEMA_VERSION_OFFSET} pins the
 * supported version at `offset + entries.length`, which is always strictly
 * greater than {@link LEGACY_PRE_SQUASH_MAX_USER_VERSION}. Every v0.1.0-era
 * pre-squash stamp (≤ 14) is therefore `<= supportedVersion` and adopted by the
 * plain comparison below, while a genuinely newer schema (always ≥ offset + 1)
 * is always strictly above the legacy band — so the two ranges never overlap
 * and downgrade detection stays monotonic. (The `version-guard` suite locks
 * this invariant.)
 */
export function isDbNewerThanCli(dbVersion: number, supportedVersion: number): boolean {
  return dbVersion > supportedVersion;
}
