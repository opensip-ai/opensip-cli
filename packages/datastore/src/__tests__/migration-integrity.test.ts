import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { requireDrizzleHandle } from '../data-store.js';
import { DataStoreFactory } from '../index.js';

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

function copyPreHostPlaneMigrations(destination: string): void {
  cpSync(MIGRATIONS_DIR, destination, { recursive: true });
  rmSync(join(destination, '0009_host_plane_namespace.sql'));
  rmSync(join(destination, 'meta', '0009_snapshot.json'));
  const journalPath = join(destination, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: JournalEntry[];
  };
  journal.entries = journal.entries.filter((entry) => entry.tag !== '0009_host_plane_namespace');
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`, 'utf8');
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

/** Read each committed snapshot's chain metadata (id/prevId), in migration order. */
function snapshotChain(): { tag: string; id: string; prevId: string }[] {
  return sqlMigrationTags()
    .map((tag) => tag.slice(0, 4))
    .map((prefix) => {
      const snap = JSON.parse(readFileSync(`${META_DIR}/${prefix}_snapshot.json`, 'utf8')) as {
        id: string;
        prevId: string;
      };
      return { tag: prefix, id: snap.id, prevId: snap.prevId };
    });
}

describe('snapshot chain integrity (drizzle-kit generate prerequisite)', () => {
  // drizzle-kit walks the snapshot chain by id/prevId. A duplicate id or a
  // prevId that does not point at the predecessor makes `db:generate` abort with
  // a "parent snapshot collision" (and exit 0, so it fails silently). This test
  // pins the chain so that regression can never merge again.
  const ZERO = '00000000-0000-0000-0000-000000000000';

  it('every snapshot id is unique', () => {
    const ids = snapshotChain().map((s) => s.id);
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(duplicates, 'duplicate snapshot ids break the drizzle chain').toEqual([]);
  });

  it('every prevId points to the predecessor snapshot id', () => {
    const chain = snapshotChain();
    const broken = chain
      .map((s, i) => ({ s, expected: i === 0 ? ZERO : chain[i - 1].id }))
      .filter(({ s, expected }) => s.prevId !== expected)
      .map(({ s, expected }) => `${s.tag}: prevId ${s.prevId} ≠ expected ${expected}`);
    expect(broken, 'snapshot prevId links must form an unbroken chain').toEqual([]);
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
      const indexes = (table: string): Set<string> =>
        new Set(
          requireDrizzleHandle(ds)
            .db.all<{ name: string }>(sql.raw(`PRAGMA index_list(${table})`))
            .map((r) => r.name),
        );

      expect(cols('sessions').has('timestamp_iso')).toBe(true); // 0010
      expect(cols('sessions').has('run_outcome')).toBe(true); // 0002 (ADR-0060)
      expect(cols('sessions').has('suite_run_id')).toBe(true); // 0004 (suite grouping)
      expect(cols('sessions').has('suite_name')).toBe(true); // 0004 (suite grouping)
      expect(cols('session_tool_payload').has('payload_version')).toBe(true); // 0010
      expect(cols('runs').has('legacy_suite_run_id')).toBe(true); // 0007 (run ledger)
      expect(cols('run_steps').has('logical_step_key')).toBe(true); // 0007 (run ledger)
      expect(cols('run_steps').has('session_id')).toBe(true); // 0007 (run ledger)
      expect(indexes('sessions').has('sessions_timestamp_idx')).toBe(true); // 0008
      expect(indexes('run_steps').has('run_steps_session_id_unique_idx')).toBe(true); // 0008
      expect(indexes('run_steps').has('run_steps_session_id_idx')).toBe(false); // replaced in 0008
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

describe('0009 host-plane namespace copy-only migration', () => {
  it('upgrades a real pre-0009 SQLite file through DataStoreFactory', () => {
    const root = mkdtempSync(join(tmpdir(), 'host-plane-migration-'));
    const oldMigrations = join(root, 'migrations-0008');
    const dbPath = join(root, 'datastore.sqlite');
    copyPreHostPlaneMigrations(oldMigrations);

    try {
      const legacy = DataStoreFactory.open({
        backend: 'sqlite',
        path: dbPath,
        migrationsFolder: oldMigrations,
      });
      requireDrizzleHandle(legacy).db.run(
        sql.raw(`
          INSERT INTO tool_state (tool, key, payload, updated_at) VALUES
            ('fit', 'governance', '{"v":1}', 100),
            ('fit', 'audit', 'null', 200),
            ('fit', 'cursor', '{"keep":true}', 300),
            ('@opensip-cli/host-plane:fit', 'governance', '{"existing":true}', 50);
        `),
      );
      legacy.close();

      const migrated = DataStoreFactory.open({
        backend: 'sqlite',
        path: dbPath,
      });
      const rows = requireDrizzleHandle(migrated).db.all<{
        tool: string;
        key: string;
        payload: string;
        updated_at: number;
      }>(sql.raw('SELECT tool, key, payload, updated_at FROM tool_state ORDER BY tool, key'));
      migrated.close();

      expect(rows.find((row) => row.tool === 'fit' && row.key === 'governance')).toMatchObject({
        payload: '{"v":1}',
        updated_at: 100,
      });
      expect(rows.find((row) => row.tool === 'fit' && row.key === 'cursor')).toMatchObject({
        payload: '{"keep":true}',
      });
      expect(
        rows.find((row) => row.tool === '@opensip-cli/host-plane:fit' && row.key === 'governance'),
      ).toMatchObject({ payload: '{"existing":true}', updated_at: 50 });
      expect(
        rows.find((row) => row.tool === '@opensip-cli/host-plane:fit' && row.key === 'audit'),
      ).toMatchObject({ payload: 'null', updated_at: 200 });

      // Reopening at the current schema is a row-for-row no-op.
      const reopened = DataStoreFactory.open({
        backend: 'sqlite',
        path: dbPath,
      });
      const after = requireDrizzleHandle(reopened).db.all(
        sql.raw('SELECT tool, key, payload, updated_at FROM tool_state ORDER BY tool, key'),
      );
      reopened.close();
      expect(after).toEqual(rows);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('copies governance/audit/entitlements to reserved identity without delete/overwrite', () => {
    // Seed a pre-migration-shaped DB by applying migrations then inserting
    // ordinary rows and re-running the 0009 SQL via a second open is not needed
    // when the factory already applied 0009: instead insert ordinary rows and
    // re-execute the committed SQL to prove idempotence + byte preservation.
    const ds = DataStoreFactory.open({ backend: 'memory' });
    try {
      const handle = requireDrizzleHandle(ds);
      // Ordinary host-key candidates + an unrelated key + already-reserved + collision.
      handle.db.run(
        sql.raw(`
          INSERT INTO tool_state (tool, key, payload, updated_at) VALUES
            ('fit', 'governance', '{"v":1}', 100),
            ('fit', 'audit', 'null', 200),
            ('fit', 'entitlements', '{"e":true}', 300),
            ('fit', 'cursor', '{"x":1}', 400),
            ('other', 'governance', '{"o":1}', 500),
            ('@opensip-cli/host-plane:fit', 'governance', '{"existing":true}', 50);
        `),
      );
      // Re-apply the committed 0009 SQL (idempotent ON CONFLICT DO NOTHING).
      const sqlText = readFileSync(`${MIGRATIONS_DIR}/0009_host_plane_namespace.sql`, 'utf8');
      // Strip SQL comments then run statements.
      const body = sqlText
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim();
      handle.db.run(sql.raw(body));

      const rows = handle.db.all<{
        tool: string;
        key: string;
        payload: string;
        updated_at: number;
      }>(sql.raw('SELECT tool, key, payload, updated_at FROM tool_state ORDER BY tool, key'));

      // Ordinary rows preserved (including collision governance on fit).
      expect(rows.find((r) => r.tool === 'fit' && r.key === 'governance')).toMatchObject({
        payload: '{"v":1}',
        updated_at: 100,
      });
      expect(rows.find((r) => r.tool === 'fit' && r.key === 'cursor')).toMatchObject({
        payload: '{"x":1}',
      });
      // Already-reserved row NOT overwritten by the copy.
      expect(
        rows.find((r) => r.tool === '@opensip-cli/host-plane:fit' && r.key === 'governance'),
      ).toMatchObject({
        payload: '{"existing":true}',
        updated_at: 50,
      });
      // Audit/entitlements for fit were copied (no prior reserved row).
      expect(
        rows.find((r) => r.tool === '@opensip-cli/host-plane:fit' && r.key === 'audit'),
      ).toMatchObject({
        payload: 'null',
        updated_at: 200,
      });
      expect(
        rows.find((r) => r.tool === '@opensip-cli/host-plane:fit' && r.key === 'entitlements'),
      ).toMatchObject({
        payload: '{"e":true}',
        updated_at: 300,
      });
      // Other tool copied too.
      expect(
        rows.find((r) => r.tool === '@opensip-cli/host-plane:other' && r.key === 'governance'),
      ).toMatchObject({
        payload: '{"o":1}',
        updated_at: 500,
      });
      // No double-prefix.
      expect(
        rows.some((r) => r.tool.includes('@opensip-cli/host-plane:@opensip-cli/host-plane:')),
      ).toBe(false);

      // Second application is a row-for-row no-op.
      const before = JSON.stringify(rows);
      handle.db.run(sql.raw(body));
      const after = handle.db.all(
        sql.raw('SELECT tool, key, payload, updated_at FROM tool_state ORDER BY tool, key'),
      );
      expect(JSON.stringify(after)).toBe(before);
    } finally {
      ds.close();
    }
  });
});
