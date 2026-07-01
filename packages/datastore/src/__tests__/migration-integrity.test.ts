import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { DataStoreFactory } from '../index.js';
import { requireDrizzleHandle } from '../data-store.js';

/**
 * Migration-integrity guardrail.
 *
 * Drizzle's runtime migrator (`drizzle-orm/better-sqlite3/migrator`) applies
 * ONLY the migrations registered in `meta/_journal.json`; a `.sql` file that is
 * not in the journal is silently ignored. That gap let three hand-authored
 * migrations (0009/0010/0011) ship without journal entries — so the columns
 * they add (`timestamp_iso`, `payload_version`; `stable_id` has since been
 * removed as dead) never reached any database, and every datastore read failed
 * with `no such column`. These tests make that class of drift fail loudly in CI
 * instead of at a user's terminal.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations', import.meta.url));
const META_DIR = fileURLToPath(new URL('../../migrations/meta', import.meta.url));

interface JournalEntry {
  idx: number;
  tag: string;
}

async function readJournal(): Promise<JournalEntry[]> {
  const raw = await readFile(
    fileURLToPath(new URL('../../migrations/meta/_journal.json', import.meta.url)),
    'utf8',
  );
  return (JSON.parse(raw) as { entries: JournalEntry[] }).entries;
}

/** Migration SQL files, e.g. `0010_add_timestamp_iso_and_payload_version`, sorted by number. */
function sqlMigrationTags(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .map((f) => f.replace(/\.sql$/, ''))
    .sort();
}

describe('migration journal ↔ SQL file parity', () => {
  it('every NNNN_*.sql migration file is registered in _journal.json (and vice versa)', async () => {
    const entries = await readJournal();
    const journalTags = entries.map((e) => e.tag).sort();
    const fileTags = sqlMigrationTags();

    // Set equality, reported as a diff so a missing/extra migration is obvious.
    const unregisteredFiles = fileTags.filter((t) => !journalTags.includes(t));
    const danglingEntries = journalTags.filter((t) => !fileTags.includes(t));

    expect(unregisteredFiles, 'SQL files present on disk but missing from _journal.json').toEqual(
      [],
    );
    expect(danglingEntries, '_journal.json entries with no matching SQL file').toEqual([]);
    expect(journalTags).toEqual(fileTags);
  });

  it('journal entry indices are contiguous and match the file ordering', async () => {
    const entries = await readJournal();
    const byIdx = [...entries].sort((a, b) => a.idx - b.idx);
    expect(byIdx.map((e) => e.idx)).toEqual(byIdx.map((_, i) => i));
    expect(byIdx.map((e) => e.tag)).toEqual(sqlMigrationTags());
  });

  it('every journal entry has a corresponding meta/NNNN_snapshot.json', async () => {
    const entries = await readJournal();
    const missing = entries
      .map((e) => `${String(e.idx).padStart(4, '0')}_snapshot.json`)
      .filter((name) => !existsSync(`${META_DIR}/${name}`));
    expect(
      missing,
      'journal entries without a drizzle snapshot (breaks future db:generate)',
    ).toEqual([]);
  });
});

describe('fresh database fully realizes the ORM schema', () => {
  it('applies the whole chain and materializes every hand-migrated column', () => {
    // Uses the real migrations folder (factory default). Throws if any migration
    // fails — e.g. a multi-statement file missing `statement-breakpoint`, or a
    // duplicate `ADD COLUMN`.
    const ds = DataStoreFactory.open({ backend: 'memory' });
    try {
      const cols = (table: string): Set<string> =>
        new Set(
          requireDrizzleHandle(ds)
            .db.all<{ name: string }>(sql.raw(`PRAGMA table_info(${table})`))
            .map((r) => r.name),
        );

      expect(cols('sessions').has('timestamp_iso')).toBe(true); // 0010
      expect(cols('sessions').has('run_outcome')).toBe(true); // 0002 (ADR-0060)
      expect(cols('sessions').has('suite_run_id')).toBe(true); // 0004 (suite grouping)
      expect(cols('sessions').has('suite_name')).toBe(true); // 0004 (suite grouping)
      expect(cols('session_tool_payload').has('payload_version')).toBe(true); // 0010
      // `stable_id` was added (ADR-0048) but never read/written; removed as dead.
      // Assert the squashed migration no longer carries it (no accidental reintro).
      expect(cols('tool_state').has('stable_id')).toBe(false);
      expect(cols('tool_baseline_entries').has('stable_id')).toBe(false);
      expect(cols('tool_baseline_meta').has('stable_id')).toBe(false);
    } finally {
      ds.close();
    }
  });
});
