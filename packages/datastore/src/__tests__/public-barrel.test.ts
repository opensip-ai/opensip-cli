import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, expectTypeOf } from 'vitest';

import type { DataStore, SqliteIntegrityResult } from '../index.js';

const indexSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../index.ts'),
  'utf8',
);

describe('datastore public barrel (ADR-0107)', () => {
  it('does not export raw handle, transaction surface, table values, or test identity', () => {
    // Strip comments so JSDoc/comment prose cannot false-positive the lock.
    const code = indexSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bDrizzleDataStore\b/);
    expect(code).not.toMatch(/\brequireDrizzleHandle\b/);
    expect(code).not.toMatch(/\bDrizzleHandle\b/);
    expect(code).not.toMatch(/\bisDrizzleDataStore\b/);
    expect(code).not.toMatch(/\btoolBaselineEntries\b/);
    expect(code).not.toMatch(/\btoolBaselineMeta\b/);
    expect(code).not.toMatch(/\btoolState\b/);
    expect(code).not.toMatch(/\bpolicyAuditEvents\b/);
    expect(code).not.toMatch(/\bDEFAULT_TEST_BASELINE_IDENTITY\b/);
    expect(code).not.toMatch(/\bSqliteLifecycleConnection\b/);
    expect(code).not.toMatch(/\bcheckpointAndCloseSqlite\b/);
    expect(code).not.toMatch(/\bbetter-sqlite3\b/);
    // Public handle must not re-export a transaction member name.
    expect(code).not.toMatch(/\btransaction\b/);
  });

  it('exposes no transaction member on the public DataStore type', () => {
    expectTypeOf<DataStore>().not.toHaveProperty('transaction');
    expectTypeOf<DataStore>().toHaveProperty('close');
    expectTypeOf<DataStore>().toHaveProperty('closeForLifecycle');
    expectTypeOf<DataStore>().toHaveProperty('withWriteLock');
  });

  it('exposes integrity evidence without a native database handle', () => {
    expectTypeOf<SqliteIntegrityResult>().not.toHaveProperty('db');
    expectTypeOf<SqliteIntegrityResult>().not.toHaveProperty('query');
    expectTypeOf<SqliteIntegrityResult>().not.toHaveProperty('transaction');
  });
});
