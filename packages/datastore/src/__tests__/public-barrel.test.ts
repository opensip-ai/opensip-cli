import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, expectTypeOf } from 'vitest';

import type { DataStore } from '../index.js';

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
    // Public handle must not re-export a transaction member name.
    expect(code).not.toMatch(/\btransaction\b/);
  });

  it('exposes no transaction member on the public DataStore type', () => {
    expectTypeOf<DataStore>().not.toHaveProperty('transaction');
    expectTypeOf<DataStore>().toHaveProperty('close');
    expectTypeOf<DataStore>().toHaveProperty('withWriteLock');
  });
});
