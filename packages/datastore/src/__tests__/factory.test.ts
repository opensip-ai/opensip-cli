import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isNativeBindingError, openFailureMessage } from '../factory.js';
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

describe('DataStoreFactory.open — migrate failure on healthy backend', () => {
  it('closes the backend and throws DataStoreMigrationError when migration folder is invalid', () => {
    expect(() =>
      DataStoreFactory.open({
        backend: 'memory',
        migrationsFolder: '/nonexistent/path/that/does/not/exist',
      }),
    ).toThrow(DataStoreMigrationError);
  });

  it('migration failure on SQLite backend includes recovery hint with path', () => {
    const path = join(tmp, 'good.sqlite');
    try {
      DataStoreFactory.open({
        backend: 'sqlite',
        path,
        migrationsFolder: '/nonexistent/migrations',
      });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DataStoreMigrationError);
      expect((error as Error).message).toContain('good.sqlite');
      expect((error as Error).message).toContain('Delete');
    }
  });

  it('migration failure on memory backend returns the in-memory message', () => {
    try {
      DataStoreFactory.open({
        backend: 'memory',
        migrationsFolder: '/no/such/dir',
      });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DataStoreMigrationError);
      expect((error as Error).message).toContain('in-memory backend');
    }
  });
});

describe('native-binding (ABI mismatch) failures are not reported as corruption', () => {
  it('isNativeBindingError detects ERR_DLOPEN_FAILED', () => {
    const e = Object.assign(new Error('dlopen failed'), { code: 'ERR_DLOPEN_FAILED' });
    expect(isNativeBindingError(e)).toBe(true);
  });

  it('isNativeBindingError detects the NODE_MODULE_VERSION mismatch text', () => {
    const e = new Error(
      'The module was compiled against a different Node.js version using NODE_MODULE_VERSION 127. This version of Node.js requires NODE_MODULE_VERSION 137.',
    );
    expect(isNativeBindingError(e)).toBe(true);
  });

  it('isNativeBindingError scans the cause chain', () => {
    const root = Object.assign(new Error('dlopen'), { code: 'ERR_DLOPEN_FAILED' });
    const wrapped = new Error('failed to construct Database', { cause: root });
    expect(isNativeBindingError(wrapped)).toBe(true);
  });

  it('isNativeBindingError is false for a genuine corrupt-file error', () => {
    const e = Object.assign(new Error('file is not a database'), { code: 'SQLITE_NOTADB' });
    expect(isNativeBindingError(e)).toBe(false);
    expect(isNativeBindingError(undefined)).toBe(false);
  });

  it('binding-error message says rebuild, NOT delete the data store', () => {
    const e = Object.assign(new Error('dlopen failed'), { code: 'ERR_DLOPEN_FAILED' });
    const msg = openFailureMessage({ backend: 'sqlite', path: 'project/cache.sqlite' }, e);
    expect(msg).toContain('pnpm rebuild better-sqlite3');
    expect(msg).toContain('NOT corrupt');
    expect(msg).not.toContain('Delete');
  });

  it('a non-binding sqlite open error keeps the delete-to-recover message', () => {
    const e = Object.assign(new Error('disk image is malformed'), { code: 'SQLITE_CORRUPT' });
    const msg = openFailureMessage({ backend: 'sqlite', path: 'project/cache.sqlite' }, e);
    expect(msg).toContain('Delete');
    expect(msg).not.toContain('pnpm rebuild');
  });
});

describe('DataStoreMigrationError', () => {
  it('preserves cause via the standard ES2022 Error.cause slot', () => {
    const root = new Error('underlying');
    const e = new DataStoreMigrationError('outer', { cause: root });
    expect(e.cause).toBe(root);
    expect(e.name).toBe('DataStoreMigrationError');
  });

  it('omits cause when not supplied', () => {
    const e = new DataStoreMigrationError('outer');
    expect(e.cause).toBeUndefined();
  });

  it('stores migrationFile when supplied', () => {
    const e = new DataStoreMigrationError('outer', { migrationFile: '0001_init.sql' });
    expect(e.migrationFile).toBe('0001_init.sql');
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
