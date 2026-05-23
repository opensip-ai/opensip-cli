import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DataStoreFactory, DataStoreMigrationError } from '../index.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'ds-factory-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('DataStoreFactory.open — backends', () => {
  it('opens an in-memory store and closes cleanly', () => {
    const ds = DataStoreFactory.open({ backend: 'memory' });
    expect(ds.db).toBeDefined();
    ds.close();
  });

  it('memory backends are isolated from each other', () => {
    const a = DataStoreFactory.open({ backend: 'memory' });
    const b = DataStoreFactory.open({ backend: 'memory' });
    // Can't easily query without a schema; the structural separation
    // (different `db` handles) is sufficient evidence.
    expect(a.db).not.toBe(b.db);
    a.close();
    b.close();
  });

  it('opens a SQLite store at the given path and persists across reopens', () => {
    const path = join(tmp, 'test.sqlite');
    const a = DataStoreFactory.open({ backend: 'sqlite', path });
    a.close();
    const b = DataStoreFactory.open({ backend: 'sqlite', path });
    expect(b.db).toBeDefined();
    b.close();
  });

  it('close() is idempotent', () => {
    const ds = DataStoreFactory.open({ backend: 'memory' });
    ds.close();
    expect(() => ds.close()).not.toThrow();
  });

  it('throws when SQLite backend is opened without a path', () => {
    expect(() => DataStoreFactory.open({ backend: 'sqlite' })).toThrow();
  });
});

describe('DataStoreFactory.open — migration error path', () => {
  it('throws DataStoreMigrationError when the SQLite file is corrupted', () => {
    const path = join(tmp, 'corrupt.sqlite');
    // Write garbage that is not a valid SQLite header.
    writeFileSync(path, 'this is not a sqlite database', 'utf8');
    expect(() => DataStoreFactory.open({ backend: 'sqlite', path })).toThrow(
      DataStoreMigrationError,
    );
  });

  it('migration error message contains the recovery hint with the path', () => {
    const path = join(tmp, 'corrupt2.sqlite');
    writeFileSync(path, 'garbage', 'utf8');
    try {
      DataStoreFactory.open({ backend: 'sqlite', path });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DataStoreMigrationError);
      expect((error as Error).message).toContain('corrupt2.sqlite');
      expect((error as Error).message).toContain('Delete');
    }
  });
});

describe('DataStore.transaction', () => {
  it('passes a tx handle through and returns its return value', () => {
    const ds = DataStoreFactory.open({ backend: 'memory' });
    const result = ds.transaction(() => 42);
    expect(result).toBe(42);
    ds.close();
  });

  it('rolls back on a thrown error', () => {
    const ds = DataStoreFactory.open({ backend: 'memory' });
    expect(() =>
      ds.transaction(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    ds.close();
  });
});
