import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LOGICAL_SCHEMA_VERSION } from '../schema-version.js';
import {
  checkpointSqliteFile,
  inspectSqliteFile,
  inspectSqliteFileWithDependencies,
  SQLITE_FOREIGN_KEY_MAX_SAMPLES,
} from '../sqlite-integrity.js';

const lockContext = {
  policy: {
    waitMs: 1000,
    staleMs: 10_000,
    heartbeatMs: 100,
  },
  command: 'test',
  cwdBasename: 'fixture',
} as const;

let temporaryDirectory: string;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'sqlite-integrity-'));
});

afterEach(() => {
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

function createDatabase(path: string, userVersion = LOGICAL_SCHEMA_VERSION): void {
  const sqlite = new Database(path);
  sqlite.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  sqlite.prepare('INSERT INTO probe (value) VALUES (?)').run('kept');
  sqlite.pragma(`user_version = ${userVersion}`);
  sqlite.close();
}

describe('inspectSqliteFile', () => {
  it('returns bounded integrity facts for a valid database', () => {
    const path = join(temporaryDirectory, 'valid.sqlite');
    createDatabase(path);

    const result = inspectSqliteFile(path);

    expect(result).toMatchObject({
      status: 'valid',
      userVersion: LOGICAL_SCHEMA_VERSION,
      supportedVersion: LOGICAL_SCHEMA_VERSION,
      supported: true,
      quickCheck: { ok: true, issueCount: 0, truncated: false },
      foreignKeys: {
        ok: true,
        violationCount: 0,
        sampleCap: SQLITE_FOREIGN_KEY_MAX_SAMPLES,
        truncated: false,
        samples: [],
      },
    });
    if (result.status !== 'valid') throw new Error('expected valid result');
    expect(result.sizeBytes).toBe(statSync(path).size);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('classifies an absent file without creating it', () => {
    const path = join(temporaryDirectory, 'absent.sqlite');

    expect(inspectSqliteFile(path)).toMatchObject({
      status: 'absent',
      reason: 'file-absent',
    });
    expect(existsSync(path)).toBe(false);
  });

  it('classifies a non-SQLite regular file without returning native details', () => {
    const path = join(temporaryDirectory, 'text.sqlite');
    writeFileSync(path, 'this is not sqlite');

    expect(inspectSqliteFile(path)).toEqual({
      status: 'not-sqlite',
      reason: 'invalid-sqlite-header',
      sidecars: {
        before: { wal: 'absent', shm: 'absent' },
        after: { wal: 'absent', shm: 'absent' },
      },
    });
  });

  it('prioritizes a hash-to-open identity change over the replacement contents', () => {
    const path = join(temporaryDirectory, 'replaced.sqlite');
    createDatabase(path);

    const result = inspectSqliteFileWithDependencies(path, {
      afterHash: () => writeFileSync(path, 'replacement is not sqlite'),
    });

    expect(result).toMatchObject({
      status: 'unreadable',
      reason: 'file-changed-during-inspection',
    });
  });

  it('does not report absent when the path appears before absence is confirmed', () => {
    const path = join(temporaryDirectory, 'appeared.sqlite');

    const result = inspectSqliteFileWithDependencies(path, {
      afterFailure: () => createDatabase(path),
    });

    expect(result).toMatchObject({
      status: 'unreadable',
      reason: 'file-changed-during-inspection',
    });
  });

  it('treats uncertain sidecar inspection as unreadable rather than absent', () => {
    if (process.platform === 'win32') return;
    const lockedDirectory = join(temporaryDirectory, 'locked');
    const path = join(lockedDirectory, 'database.sqlite');
    mkdirSync(lockedDirectory);
    createDatabase(path);
    chmodSync(lockedDirectory, 0o000);
    try {
      expect(inspectSqliteFile(path)).toMatchObject({
        status: 'unreadable',
        reason: 'sidecar-inspection-failed',
      });
    } finally {
      chmodSync(lockedDirectory, 0o700);
    }
  });

  it('accepts a close exception when the native handle is nevertheless closed', () => {
    const path = join(temporaryDirectory, 'close-after-throw.sqlite');
    createDatabase(path);

    const result = inspectSqliteFileWithDependencies(path, {
      openDatabase: (databasePath) => {
        const sqlite = new Database(databasePath, {
          readonly: true,
          fileMustExist: true,
        });
        return {
          get open() {
            return sqlite.open;
          },
          pragma: sqlite.pragma.bind(sqlite),
          prepare: sqlite.prepare.bind(sqlite),
          close(): void {
            sqlite.close();
            throw new Error('private close detail');
          },
        } as unknown as Database.Database;
      },
    });

    expect(result).toMatchObject({ status: 'valid' });
  });

  it('reports a newer user_version as unsupported after integrity checks', () => {
    const path = join(temporaryDirectory, 'future.sqlite');
    createDatabase(path, LOGICAL_SCHEMA_VERSION + 1);

    const result = inspectSqliteFile(path);

    expect(result).toMatchObject({
      status: 'unsupported',
      reason: 'schema-newer-than-cli',
      supported: false,
      userVersion: LOGICAL_SCHEMA_VERSION + 1,
      supportedVersion: LOGICAL_SCHEMA_VERSION,
      quickCheck: { ok: true },
      foreignKeys: { ok: true },
    });
  });

  it('detects a database page corrupted after close', () => {
    const path = join(temporaryDirectory, 'corrupt.sqlite');
    const sqlite = new Database(path);
    sqlite.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    const insert = sqlite.prepare('INSERT INTO probe (value) VALUES (?)');
    const largeValue = 'x'.repeat(2000);
    sqlite.transaction(() => {
      for (let index = 0; index < 100; index += 1) insert.run(largeValue);
    })();
    const pageSize = Number(sqlite.pragma('page_size', { simple: true }));
    sqlite.close();

    const descriptor = openSync(path, 'r+');
    try {
      writeSync(descriptor, Buffer.alloc(256, 0xff), 0, 256, pageSize);
    } finally {
      closeSync(descriptor);
    }

    expect(inspectSqliteFile(path)).toMatchObject({ status: 'corrupt' });
  });

  it('reports foreign-key violations with a bounded sample', () => {
    const path = join(temporaryDirectory, 'foreign-key.sqlite');
    const sqlite = new Database(path);
    sqlite.pragma('foreign_keys = OFF');
    sqlite.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (
        id INTEGER PRIMARY KEY,
        parent_id INTEGER NOT NULL REFERENCES parent(id)
      );
    `);
    const insert = sqlite.prepare('INSERT INTO child (parent_id) VALUES (?)');
    const count = SQLITE_FOREIGN_KEY_MAX_SAMPLES + 5;
    sqlite.transaction(() => {
      for (let index = 0; index < count; index += 1) insert.run(index + 1);
    })();
    sqlite.close();

    const result = inspectSqliteFile(path);

    expect(result).toMatchObject({
      status: 'corrupt',
      reason: 'foreign-key-violations',
      foreignKeys: {
        ok: false,
        violationCount: SQLITE_FOREIGN_KEY_MAX_SAMPLES + 1,
        sampleCap: SQLITE_FOREIGN_KEY_MAX_SAMPLES,
        truncated: true,
      },
    });
    if (!('foreignKeys' in result)) throw new Error('expected completed inspection');
    expect(result.foreignKeys.samples).toHaveLength(SQLITE_FOREIGN_KEY_MAX_SAMPLES);
    expect(result.foreignKeys.samples[0]).toMatchObject({
      table: 'child',
      parent: 'parent',
      foreignKeyIndex: 0,
    });
  });

  it('does not migrate or create application tables while inspecting', () => {
    const path = join(temporaryDirectory, 'unmigrated.sqlite');
    const sqlite = new Database(path);
    sqlite.close();

    expect(inspectSqliteFile(path)).toMatchObject({
      status: 'valid',
      userVersion: 0,
    });

    const reopened = new Database(path, {
      readonly: true,
      fileMustExist: true,
    });
    const tables = reopened
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    reopened.close();
    expect(tables).toEqual([]);
  });
});

describe('checkpointSqliteFile', () => {
  it('uses file-must-exist and leaves no file or write lock on open failure', () => {
    const path = join(temporaryDirectory, 'missing.sqlite');

    expect(() => checkpointSqliteFile(path, lockContext)).toThrow(
      'Unable to open the existing SQLite file for checkpointing',
    );
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.write.lock`)).toBe(false);
  });

  it('folds WAL content into the main file and returns a closed proof', () => {
    const path = join(temporaryDirectory, 'wal.sqlite');
    const writer = new Database(path);
    writer.pragma('journal_mode = WAL');
    writer.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
    writer.prepare('INSERT INTO probe (value) VALUES (?)').run('from-wal');

    const result = checkpointSqliteFile(path, lockContext);
    writer.close();

    expect(result).toEqual({ checkpointed: true, closed: true });
    expect(existsSync(`${path}.write.lock`)).toBe(false);
    if (existsSync(`${path}-wal`)) expect(statSync(`${path}-wal`).size).toBe(0);

    const reopened = new Database(path, {
      readonly: true,
      fileMustExist: true,
    });
    expect(reopened.prepare('SELECT value FROM probe').pluck().get()).toBe('from-wal');
    reopened.close();
  });

  it('produces a stable main-file digest after checkpoint and copy', () => {
    const source = join(temporaryDirectory, 'source.sqlite');
    const copy = join(temporaryDirectory, 'copy.sqlite');
    createDatabase(source);

    expect(checkpointSqliteFile(source, lockContext).closed).toBe(true);
    copyFileSync(source, copy);

    const sourceResult = inspectSqliteFile(source);
    const copyResult = inspectSqliteFile(copy);
    if (sourceResult.status !== 'valid' || copyResult.status !== 'valid') {
      throw new Error('expected valid source and copy');
    }
    expect(copyResult.sha256).toBe(sourceResult.sha256);
    expect(copyResult.sizeBytes).toBe(sourceResult.sizeBytes);
  });
});
