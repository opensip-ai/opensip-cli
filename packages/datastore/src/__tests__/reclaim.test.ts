import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { requireDrizzleHandle } from '../data-store.js';
import { DataStoreFactory } from '../index.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'opensip-datastore-reclaim-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function readAutoVacuum(path: string): number {
  const db = new Database(path);
  try {
    return Number(db.pragma('auto_vacuum', { simple: true }));
  } finally {
    db.close();
  }
}

describe('SQLite reclaim primitives', () => {
  it('converts a legacy auto_vacuum=NONE database to INCREMENTAL on open', () => {
    const path = join(tmp, 'legacy.sqlite');
    const legacy = new Database(path);
    legacy.pragma('auto_vacuum = NONE');
    legacy.exec('CREATE TABLE legacy_data (id INTEGER PRIMARY KEY, value TEXT);');
    legacy.exec("INSERT INTO legacy_data (value) VALUES ('x');");
    legacy.close();

    expect(readAutoVacuum(path)).toBe(0);

    const opened = DataStoreFactory.open({ backend: 'sqlite', path });
    opened.close();
    expect(readAutoVacuum(path)).toBe(2);

    const reopened = DataStoreFactory.open({ backend: 'sqlite', path });
    reopened.close();
    expect(readAutoVacuum(path)).toBe(2);
  });

  it('exposes file-backed maintenance operations', () => {
    const path = join(tmp, 'reclaim.sqlite');
    const datastore = DataStoreFactory.open({ backend: 'sqlite', path });
    const maintenance = datastore.maintenance;
    expect(maintenance).toBeDefined();
    if (maintenance === undefined) throw new Error('expected sqlite maintenance capability');

    const db = requireDrizzleHandle(datastore).db;
    const initialSize = maintenance.fileSizeBytes();
    db.run(sql`CREATE TABLE reclaim_probe (payload TEXT NOT NULL)`);
    const payload = 'x'.repeat(4096);
    for (let i = 0; i < 128; i += 1) {
      db.run(sql`INSERT INTO reclaim_probe (payload) VALUES (${payload})`);
    }
    const populatedSize = maintenance.fileSizeBytes();
    expect(populatedSize).toBeGreaterThanOrEqual(initialSize);

    db.run(sql`DELETE FROM reclaim_probe`);
    maintenance.incrementalVacuum();
    const afterIncremental = maintenance.fileSizeBytes();
    expect(afterIncremental).toBeLessThanOrEqual(populatedSize);

    maintenance.fullVacuum();
    expect(maintenance.fileSizeBytes()).toBeLessThanOrEqual(afterIncremental);
    datastore.close();
  });

  it('does not expose maintenance for the in-memory backend', () => {
    const datastore = DataStoreFactory.open({ backend: 'memory' });
    expect(datastore.maintenance).toBeUndefined();
    datastore.close();
  });
});
