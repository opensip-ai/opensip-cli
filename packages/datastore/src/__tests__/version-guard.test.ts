import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DataStoreFactory, DataStoreVersionError } from '../index.js';
import {
  isDbNewerThanCli,
  LEGACY_PRE_SQUASH_MAX_USER_VERSION,
  LOGICAL_SCHEMA_VERSION,
  readSupportedDbVersion,
} from '../schema-version.js';

/** The bundled migrations folder lives at the package root (mirrors factory's default). */
const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

/** Read SQLite's `PRAGMA user_version` directly via a throwaway connection. */
function readUserVersion(path: string): number {
  const db = new Database(path);
  try {
    return Number(db.pragma('user_version', { simple: true }));
  } finally {
    db.close();
  }
}

/** Force a `PRAGMA user_version` onto an existing file via a throwaway connection. */
function writeUserVersion(path: string, version: number): void {
  const db = new Database(path);
  try {
    db.pragma(`user_version = ${version}`);
  } finally {
    db.close();
  }
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ds-version-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('readSupportedDbVersion', () => {
  it('returns the logical schema version when the journal is readable', () => {
    const journal = JSON.parse(
      readFileSync(join(MIGRATIONS_FOLDER, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: unknown[] };
    expect(journal.entries.length).toBeGreaterThanOrEqual(1);
    expect(readSupportedDbVersion(MIGRATIONS_FOLDER)).toBe(LOGICAL_SCHEMA_VERSION);
  });

  it('is independent of journal entry count (squash-safe)', () => {
    expect(readSupportedDbVersion(MIGRATIONS_FOLDER)).toBe(LOGICAL_SCHEMA_VERSION);
    expect(readSupportedDbVersion(MIGRATIONS_FOLDER)).not.toBe(LEGACY_PRE_SQUASH_MAX_USER_VERSION);
  });

  it('returns undefined for an unreadable journal (broken install)', () => {
    expect(readSupportedDbVersion(join(tmp, 'does-not-exist'))).toBeUndefined();
  });
});

describe('isDbNewerThanCli', () => {
  it('blocks only when the db is strictly ahead of the CLI', () => {
    expect(isDbNewerThanCli(7, 6)).toBe(true);
    expect(isDbNewerThanCli(6, 6)).toBe(false); // equal = same schema, safe
    expect(isDbNewerThanCli(0, 6)).toBe(false); // fresh / legacy, safe
  });

  it('adopts v0.1.0 legacy stamps (journal count ≤ 14) against logical v2', () => {
    expect(isDbNewerThanCli(LEGACY_PRE_SQUASH_MAX_USER_VERSION, LOGICAL_SCHEMA_VERSION)).toBe(
      false,
    );
    expect(isDbNewerThanCli(LEGACY_PRE_SQUASH_MAX_USER_VERSION + 1, LOGICAL_SCHEMA_VERSION)).toBe(
      true,
    );
  });
});

describe('DataStoreFactory.open — version stamp', () => {
  it('stamps a freshly created SQLite db with the supported version', () => {
    const path = join(tmp, 'fresh.sqlite');
    const supported = readSupportedDbVersion(MIGRATIONS_FOLDER);
    const ds = DataStoreFactory.open({ backend: 'sqlite', path });
    ds.close();
    expect(readUserVersion(path)).toBe(supported);
  });

  it('adopts a pre-guard "legacy" db (user_version 0) and re-stamps it', () => {
    const path = join(tmp, 'legacy.sqlite');
    // Create + migrate, then simulate a legacy file by clearing the stamp.
    DataStoreFactory.open({ backend: 'sqlite', path }).close();
    writeUserVersion(path, 0);
    expect(readUserVersion(path)).toBe(0);

    // Reopening must NOT throw, and must re-stamp to the supported version.
    const reopened = DataStoreFactory.open({ backend: 'sqlite', path });
    reopened.close();
    expect(readUserVersion(path)).toBe(readSupportedDbVersion(MIGRATIONS_FOLDER));
  });

  it('adopts a v0.1.0 legacy stamp (user_version 14) without DataStoreVersionError', () => {
    const path = join(tmp, 'legacy-v010.sqlite');
    DataStoreFactory.open({ backend: 'sqlite', path }).close();
    writeUserVersion(path, LEGACY_PRE_SQUASH_MAX_USER_VERSION);
    expect(readUserVersion(path)).toBe(LEGACY_PRE_SQUASH_MAX_USER_VERSION);

    const reopened = DataStoreFactory.open({ backend: 'sqlite', path });
    reopened.close();
    expect(readUserVersion(path)).toBe(LOGICAL_SCHEMA_VERSION);
  });

  it('reopening an already-current db is a no-op that preserves the stamp', () => {
    const path = join(tmp, 'reopen.sqlite');
    DataStoreFactory.open({ backend: 'sqlite', path }).close();
    const first = readUserVersion(path);
    DataStoreFactory.open({ backend: 'sqlite', path }).close();
    expect(readUserVersion(path)).toBe(first);
  });
});

describe('DataStoreFactory.open — downgrade guard', () => {
  it('throws DataStoreVersionError when the db was written by a newer CLI', () => {
    const path = join(tmp, 'future.sqlite');
    DataStoreFactory.open({ backend: 'sqlite', path }).close();
    // Stamp it far ahead of anything this CLI could support.
    writeUserVersion(path, 9999);

    expect(() => DataStoreFactory.open({ backend: 'sqlite', path })).toThrow(DataStoreVersionError);
  });

  it('the error message points at the install script and the delete fallback', () => {
    const path = join(tmp, 'future-msg.sqlite');
    DataStoreFactory.open({ backend: 'sqlite', path }).close();
    writeUserVersion(path, 9999);

    try {
      DataStoreFactory.open({ backend: 'sqlite', path });
      expect.unreachable('open should have thrown DataStoreVersionError');
    } catch (error) {
      expect(error).toBeInstanceOf(DataStoreVersionError);
      const err = error as DataStoreVersionError;
      expect(err.dbVersion).toBe(9999);
      expect(err.supportedVersion).toBe(readSupportedDbVersion(MIGRATIONS_FOLDER));
      expect(err.message).toContain('curl -fsSL https://opensip.ai/cli/install.sh | bash');
      expect(err.message).toContain(path);
    }
  });
});
