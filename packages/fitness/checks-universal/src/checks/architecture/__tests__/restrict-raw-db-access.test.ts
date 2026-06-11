/**
 * Unit tests for the pure `analyzeRawDbAccess` detector behind the
 * `restrict-raw-db-access` check (ADR-0009). The detector operates on
 * `strip-strings`-filtered content (the framework applies the `contentFilter`
 * before calling `analyze`), so these tests feed it the already-filtered shape:
 * real call sites survive; string/comment text does not.
 *
 * Modelled on `no-direct-stdout-in-tool-engine.test.ts` — a pure
 * `(content, filePath) => violations[]` detector exercised with no framework,
 * no IO, no mocks.
 */
import { describe, expect, it } from 'vitest';

import { analyzeRawDbAccess } from '../restrict-raw-db-access.js';

const OUTSIDE = 'packages/fitness/engine/src/cli/run-fit.ts';

describe('analyzeRawDbAccess', () => {
  it('flags `.db.select(` outside the persistence boundary', () => {
    const violations = analyzeRawDbAccess(
      'const r = this.datastore.db.select().from(t).get();',
      OUTSIDE,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(1);
    expect(violations[0]?.severity).toBe('error');
    expect(violations[0]?.message).toContain('persistence boundary');
  });

  it('flags every Drizzle query/builder method', () => {
    for (const m of [
      'select',
      'insert',
      'update',
      'delete',
      'transaction',
      'run',
      'get',
      'all',
      'values',
      'with',
    ]) {
      expect(analyzeRawDbAccess(`store.db.${m}(x)`, OUTSIDE)).toHaveLength(1);
    }
  });

  it('does NOT flag `.db.select(` INSIDE a src/persistence/ layer', () => {
    const persistence = 'packages/graph/engine/src/persistence/baseline-repo.ts';
    expect(
      analyzeRawDbAccess('this.datastore.db.select().from(t).get();', persistence),
    ).toHaveLength(0);
  });

  it('does NOT flag `.db` use in session-store or datastore packages', () => {
    expect(
      analyzeRawDbAccess(
        'this.datastore.db.delete(sessions).run();',
        'packages/session-store/src/session-repo.ts',
      ),
    ).toHaveLength(0);
    expect(
      analyzeRawDbAccess(
        'migrate(datastore.db, { migrationsFolder });',
        'packages/datastore/src/factory.ts',
      ),
    ).toHaveLength(0);
  });

  it('does NOT flag test files (fixtures legitimately reach the handle)', () => {
    expect(
      analyzeRawDbAccess('store.db.select().from(t)', 'packages/foo/src/x.test.ts'),
    ).toHaveLength(0);
    expect(
      analyzeRawDbAccess('store.db.select().from(t)', 'packages/foo/src/__tests__/x.ts'),
    ).toHaveLength(0);
  });

  it('does NOT flag an unrelated `.db` field that is not a query handle', () => {
    // `config.db` is a property, not a Drizzle query call — must not trip.
    expect(analyzeRawDbAccess('const host = config.db.host;', OUTSIDE)).toHaveLength(0);
    expect(analyzeRawDbAccess('const name = options.db.name ?? "default";', OUTSIDE)).toHaveLength(
      0,
    );
    // A `.db` followed by a non-Drizzle method is also not flagged.
    expect(analyzeRawDbAccess('logger.db.warn("x")', OUTSIDE)).toHaveLength(0);
  });

  it('does NOT flag an arbitrary bare local `db.select(` with no raw-handle alias', () => {
    expect(analyzeRawDbAccess('db.select().from(t)', OUTSIDE)).toHaveLength(0);
  });

  it('flags a raw handle assigned to a local alias', () => {
    const content = ['const rawDb = store.db;', 'rawDb.select().from(t).get();'].join('\n');
    const violations = analyzeRawDbAccess(content, OUTSIDE);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(2);
  });

  it('flags a raw handle destructured to `db` or an alias', () => {
    expect(
      analyzeRawDbAccess(
        ['const { db } = store;', 'db.insert(t).values(v).run();'].join('\n'),
        OUTSIDE,
      ),
    ).toHaveLength(1);
    expect(
      analyzeRawDbAccess(
        ['const { db: rawDb } = store;', 'rawDb.delete(t).run();'].join('\n'),
        OUTSIDE,
      ),
    ).toHaveLength(1);
  });

  it('reports correct line numbers and one violation per offending line', () => {
    const content = ['const a = 1;', 'store.db.insert(t).values(v).run();', 'const b = 2;'].join(
      '\n',
    );
    const violations = analyzeRawDbAccess(content, OUTSIDE);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(2);
  });

  it('carries a remediation suggestion pointing at the ignore directive', () => {
    const violations = analyzeRawDbAccess('store.db.select(x)', OUTSIDE);
    expect(violations[0]?.suggestion).toContain('restrict-raw-db-access');
  });

  it('returns no violations for clean content', () => {
    expect(analyzeRawDbAccess('export function f() { return 1 }', OUTSIDE)).toEqual([]);
  });
});
