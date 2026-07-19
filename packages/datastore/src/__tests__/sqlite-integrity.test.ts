import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
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
  checkpointSqliteFileWithDependencies,
  inspectSqliteFile,
  inspectSqliteFileWithDependencies,
  sqliteCheckpointFailureResult,
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

function unclosedInspectionDatabase(): Database.Database {
  return {
    open: true,
    pragma: (pragma: string, options?: { readonly simple?: boolean }): unknown => {
      if (pragma === 'user_version' && options?.simple === true) {
        return LOGICAL_SCHEMA_VERSION;
      }
      return [{ quick_check: 'ok' }];
    },
    prepare: () => ({ all: () => [] }),
    close: () => {
      throw new Error('private native close detail');
    },
  } as unknown as Database.Database;
}

function inspectionDatabase(options: {
  readonly userVersion?: unknown;
  readonly quickCheck?: unknown;
  readonly foreignKeys?: readonly unknown[];
}): Database.Database {
  let open = true;
  return {
    get open() {
      return open;
    },
    pragma: (pragma: string, pragmaOptions?: { readonly simple?: boolean }): unknown => {
      if (pragma === 'user_version' && pragmaOptions?.simple === true) {
        return options.userVersion ?? LOGICAL_SCHEMA_VERSION;
      }
      return options.quickCheck ?? [{ quick_check: 'ok' }];
    },
    prepare: () => ({ all: () => options.foreignKeys ?? [] }),
    close: () => {
      open = false;
    },
  } as unknown as Database.Database;
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

  it('reports a file removed after hashing as changed rather than absent', () => {
    const path = join(temporaryDirectory, 'removed-after-hash.sqlite');
    createDatabase(path);

    expect(
      inspectSqliteFileWithDependencies(path, {
        afterHash: () => rmSync(path),
      }),
    ).toMatchObject({
      status: 'unreadable',
      reason: 'file-changed-during-inspection',
    });
  });

  it.each(['directory', 'hardlink'] as const)(
    'rejects a SQLite path whose file posture is %s',
    (posture) => {
      const path = join(temporaryDirectory, `${posture}.sqlite`);
      if (posture === 'directory') {
        mkdirSync(path);
      } else {
        const original = join(temporaryDirectory, 'hardlink-source.sqlite');
        createDatabase(original);
        linkSync(original, path);
      }

      expect(inspectSqliteFile(path)).toMatchObject({
        status: 'corrupt',
        reason: 'invalid-file-type',
      });
    },
  );

  it.each(['SQLITE_CORRUPT', 'SQLITE_CORRUPT_INDEX'] as const)(
    'maps native %s failures to bounded corruption evidence',
    (code) => {
      const path = join(temporaryDirectory, `${code}.sqlite`);
      createDatabase(path);

      expect(
        inspectSqliteFileWithDependencies(path, {
          openDatabase: () => {
            throw Object.assign(new Error('private native detail'), { code });
          },
        }),
      ).toMatchObject({
        status: 'corrupt',
        reason: 'sqlite-corrupt',
      });
    },
  );

  it('rejects invalid user-version and quick-check response shapes', () => {
    const versionPath = join(temporaryDirectory, 'invalid-user-version.sqlite');
    const quickPath = join(temporaryDirectory, 'invalid-quick-check.sqlite');
    createDatabase(versionPath);
    createDatabase(quickPath);

    expect(
      inspectSqliteFileWithDependencies(versionPath, {
        openDatabase: () => inspectionDatabase({ userVersion: -1 }),
      }),
    ).toMatchObject({ status: 'corrupt', reason: 'sqlite-corrupt' });
    expect(
      inspectSqliteFileWithDependencies(quickPath, {
        openDatabase: () => inspectionDatabase({ quickCheck: [] }),
      }),
    ).toMatchObject({ status: 'corrupt', reason: 'sqlite-corrupt' });
  });

  it('bounds malformed quick-check and foreign-key rows without leaking native values', () => {
    const quickPath = join(temporaryDirectory, 'malformed-quick-row.sqlite');
    const foreignPath = join(temporaryDirectory, 'malformed-foreign-row.sqlite');
    createDatabase(quickPath);
    createDatabase(foreignPath);

    expect(
      inspectSqliteFileWithDependencies(quickPath, {
        openDatabase: () => inspectionDatabase({ quickCheck: [{}] }),
      }),
    ).toMatchObject({
      status: 'corrupt',
      reason: 'quick-check-failed',
      quickCheck: { issueCount: 1 },
    });
    expect(
      inspectSqliteFileWithDependencies(foreignPath, {
        openDatabase: () =>
          inspectionDatabase({
            foreignKeys: [{ table: 42, parent: null, rowid: 9n, fkid: -2 }],
          }),
      }),
    ).toMatchObject({
      status: 'corrupt',
      reason: 'foreign-key-violations',
      foreignKeys: {
        samples: [{ table: '', parent: '', rowId: '9', foreignKeyIndex: -1 }],
      },
    });
  });

  it('runs the caller authority guard after hashing and before native open', () => {
    const path = join(temporaryDirectory, 'guarded-open.sqlite');
    createDatabase(path);
    const events: string[] = [];
    let opened = false;

    const result = inspectSqliteFileWithDependencies(path, {
      afterHash: () => events.push('hashed'),
      beforeOpen: () => {
        events.push('guarded');
        throw new Error('authority changed');
      },
      openDatabase: (databasePath) => {
        opened = true;
        return new Database(databasePath, {
          readonly: true,
          fileMustExist: true,
        });
      },
    });

    expect(result).toMatchObject({
      status: 'unreadable',
      reason: 'inspection-failed',
    });
    expect(events).toEqual(['hashed', 'guarded']);
    expect(opened).toBe(false);
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

  it('reports an unclosed native inspection handle without exposing native detail', () => {
    const path = join(temporaryDirectory, 'unclosed-inspection.sqlite');
    createDatabase(path);

    const result = inspectSqliteFileWithDependencies(path, {
      openDatabase: unclosedInspectionDatabase,
    });

    expect(result).toMatchObject({
      status: 'unreadable',
      reason: 'native-close-failed',
    });
  });

  it('preserves an unclosed proof over a simultaneous main-file identity change', () => {
    const path = join(temporaryDirectory, 'unclosed-and-replaced.sqlite');
    createDatabase(path);

    const result = inspectSqliteFileWithDependencies(path, {
      openDatabase: unclosedInspectionDatabase,
      afterFailure: () => writeFileSync(path, 'replacement'),
    });

    expect(result).toMatchObject({
      status: 'unreadable',
      reason: 'native-close-failed',
    });
  });

  it('preserves an unclosed proof when failure diagnostics also throw', () => {
    const path = join(temporaryDirectory, 'unclosed-diagnostic-failure.sqlite');
    createDatabase(path);

    const result = inspectSqliteFileWithDependencies(path, {
      openDatabase: unclosedInspectionDatabase,
      afterFailure: () => {
        throw new Error('private diagnostic detail');
      },
    });

    expect(result).toMatchObject({
      status: 'unreadable',
      reason: 'native-close-failed',
    });
  });

  it('preserves an unclosed proof when sidecar and identity diagnostics are unavailable', () => {
    if (process.platform === 'win32') return;
    const parent = join(temporaryDirectory, 'unclosed-unreadable-parent');
    const path = join(parent, 'database.sqlite');
    mkdirSync(parent);
    createDatabase(path);

    try {
      const result = inspectSqliteFileWithDependencies(path, {
        openDatabase: unclosedInspectionDatabase,
        afterFailure: () => chmodSync(parent, 0o000),
      });

      expect(result).toMatchObject({
        status: 'unreadable',
        reason: 'native-close-failed',
      });
    } finally {
      chmodSync(parent, 0o700);
    }
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

  it('returns bounded close proofs for before-open and after-close guard failures', () => {
    const beforePath = join(temporaryDirectory, 'before-open.sqlite');
    const afterPath = join(temporaryDirectory, 'after-close.sqlite');
    createDatabase(beforePath);
    createDatabase(afterPath);
    let opened = false;

    let beforeFailure: unknown;
    try {
      checkpointSqliteFileWithDependencies(
        beforePath,
        lockContext,
        {
          beforeOpen: () => {
            throw new Error('authority changed');
          },
        },
        {
          openDatabase: () => {
            opened = true;
            return inspectionDatabase({});
          },
        },
      );
    } catch (error) {
      beforeFailure = error;
    }
    expect(opened).toBe(false);
    expect(sqliteCheckpointFailureResult(beforeFailure)).toEqual({
      checkpointed: false,
      closed: true,
      reason: 'checkpoint-failed',
    });

    let afterFailure: unknown;
    try {
      checkpointSqliteFile(afterPath, lockContext, {
        afterClose: () => {
          throw new Error('authority changed');
        },
      });
    } catch (error) {
      afterFailure = error;
    }
    expect(sqliteCheckpointFailureResult(afterFailure)).toEqual({
      checkpointed: true,
      closed: true,
    });
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

  it('uses an explicit maintenance lock and runs guards inside that lock', () => {
    const path = join(temporaryDirectory, 'guarded.sqlite');
    const lockPath = join(temporaryDirectory, 'coordination', 'maintenance.lock');
    mkdirSync(join(temporaryDirectory, 'coordination'));
    createDatabase(path);
    const events: string[] = [];

    expect(
      checkpointSqliteFile(path, lockContext, {
        lockPath,
        beforeOpen: () => {
          expect(existsSync(lockPath)).toBe(true);
          events.push('before-open');
        },
        afterOpen: () => {
          expect(existsSync(lockPath)).toBe(true);
          events.push('after-open');
        },
        beforeCheckpoint: () => {
          expect(existsSync(lockPath)).toBe(true);
          events.push('before-checkpoint');
        },
        afterClose: () => {
          expect(existsSync(lockPath)).toBe(true);
          events.push('after-close');
        },
      }),
    ).toEqual({ checkpointed: true, closed: true });

    expect(events).toEqual(['before-open', 'after-open', 'before-checkpoint', 'after-close']);
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${path}.write.lock`)).toBe(false);
  });

  it('closes the native handle and removes the explicit lock when an in-lock guard fails', () => {
    const path = join(temporaryDirectory, 'guard-failure.sqlite');
    const lockPath = join(temporaryDirectory, 'maintenance.lock');
    createDatabase(path);

    expect(() =>
      checkpointSqliteFile(path, lockContext, {
        lockPath,
        afterOpen: () => {
          throw new Error('authority changed');
        },
      }),
    ).toThrow('Unable to open the existing SQLite file for checkpointing');
    expect(existsSync(lockPath)).toBe(false);
    expect(existsSync(`${path}.write.lock`)).toBe(false);

    const reopened = new Database(path, {
      readonly: true,
      fileMustExist: true,
    });
    expect(reopened.pragma('quick_check', { simple: true })).toBe('ok');
    reopened.close();
  });

  it('preserves an unclosed native-handle proof when an in-lock guard fails', () => {
    const path = join(temporaryDirectory, 'guard-close-failure.sqlite');
    let failure: unknown;
    const sqlite = {
      open: true,
      pragma: () => [{ busy: 0, log: 0, checkpointed: 0 }],
      close: () => {
        throw new Error('native close failed');
      },
    };

    try {
      checkpointSqliteFileWithDependencies(
        path,
        lockContext,
        {
          afterOpen: () => {
            throw new Error('authority changed');
          },
        },
        { openDatabase: () => sqlite },
      );
    } catch (error) {
      failure = error;
    }

    expect(sqliteCheckpointFailureResult(failure)).toEqual({
      checkpointed: false,
      closed: false,
      reason: 'checkpoint-and-close-failed',
    });
    expect(existsSync(`${path}.write.lock`)).toBe(false);
  });

  it('marks pre-open failures as release-safe without exposing native error detail', () => {
    const path = join(temporaryDirectory, 'open-failure.sqlite');
    let failure: unknown;

    try {
      checkpointSqliteFileWithDependencies(
        path,
        lockContext,
        {},
        {
          openDatabase: () => {
            throw new Error('private native detail');
          },
        },
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      message: 'Unable to open the existing SQLite file for checkpointing',
    });
    expect(sqliteCheckpointFailureResult(failure)).toEqual({
      checkpointed: false,
      closed: true,
      reason: 'checkpoint-failed',
    });
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
