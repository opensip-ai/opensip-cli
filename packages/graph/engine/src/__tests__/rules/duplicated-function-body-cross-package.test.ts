/**
 * Aggregate cross-package code path for the duplicated-function-body rule.
 *
 * Validates the second, package-spread code path: a body hash present in
 * ≥ minCrossPackageDuplicatePackages DISTINCT packages (via pkgOf) emits
 * ONE aggregate signal with NO per-copy size/line floor, and suppresses
 * the per-instance signals for that same hash.
 */

import { describe, expect, it } from 'vitest';

import { buildIndexes } from '../../pipeline/indexes.js';
import { duplicatedFunctionBodyRule } from '../../rules/duplicated-function-body.js';

import { makeCatalog, occ } from './_helpers.js';

import type { Signal } from '@opensip-tools/core';

/** Aggregate signals carry a `packages` array; per-instance ones carry `primary`. */
function aggregates(signals: readonly Signal[]): readonly Signal[] {
  return signals.filter((s) => Array.isArray(s.metadata.packages));
}
function perInstance(signals: readonly Signal[]): readonly Signal[] {
  return signals.filter((s) => typeof s.metadata.primary === 'string');
}

const evaluate = duplicatedFunctionBodyRule.evaluate.bind(duplicatedFunctionBodyRule);

describe('duplicated-function-body aggregate cross-package path', () => {
  it('fires exactly one aggregate signal for a small body in 3 packages', () => {
    // Small bodySize (50) is below the default minDuplicateBodySize (200),
    // so the per-instance path would be silent — the aggregate path catches it.
    const small = { bodySize: 50, line: 1, endLine: 2 };
    const a = occ({ bodyHash: 'h', simpleName: 'stripStrings', package: 'pkg-c', ...small });
    const b = occ({
      bodyHash: 'h',
      simpleName: 'stripStrings',
      package: 'pkg-a',
      filePath: 'src/b.ts',
      qualifiedName: 'src/b.stripStrings',
      ...small,
    });
    const c = occ({
      bodyHash: 'h',
      simpleName: 'stripStrings',
      package: 'pkg-b',
      filePath: 'src/c.ts',
      qualifiedName: 'src/c.stripStrings',
      ...small,
    });
    const catalog = makeCatalog([a, b, c]);
    const signals = evaluate(catalog, buildIndexes(catalog), {});

    const agg = aggregates(signals);
    expect(agg).toHaveLength(1);
    expect(perInstance(signals)).toHaveLength(0);

    const s = agg[0];
    expect(s?.metadata.packages).toEqual(['pkg-a', 'pkg-b', 'pkg-c']);
    expect(s?.metadata.packageCount).toBe(3);
    expect(s?.metadata.occurrenceCount).toBe(3);
    expect(s?.metadata.bodyHash).toBe('h');
    expect(s?.severity).toBe('low');
    expect(s?.category).toBe('quality');
    expect(s?.ruleId).toBe('graph:duplicated-function-body');
    // Anchored at lexicographically-lowest qualifiedName (src/b < src/c < src/a's `src/a.*`?).
    // qualifiedNames are: src/a.stripStrings, src/b.stripStrings, src/c.stripStrings.
    expect(s?.code?.file).toBe('src/a.ts');
  });

  it('does NOT fire for a within-package small dup (1 package)', () => {
    const small = { bodySize: 50, line: 1, endLine: 2, package: 'pkg-a' };
    const a = occ({ bodyHash: 'h', simpleName: 'a', ...small });
    const b = occ({ bodyHash: 'h', simpleName: 'b', filePath: 'src/b.ts', ...small });
    const c = occ({ bodyHash: 'h', simpleName: 'c', filePath: 'src/c.ts', ...small });
    const catalog = makeCatalog([a, b, c]);
    const signals = evaluate(catalog, buildIndexes(catalog), {});
    expect(signals).toHaveLength(0);
  });

  it('honors the minCrossPackageDuplicatePackages threshold', () => {
    const small = { bodySize: 50, line: 1, endLine: 2 };
    const a = occ({ bodyHash: 'h', simpleName: 'a', package: 'pkg-a', ...small });
    const b = occ({
      bodyHash: 'h',
      simpleName: 'b',
      package: 'pkg-b',
      filePath: 'src/b.ts',
      qualifiedName: 'src/b.b',
      ...small,
    });
    const catalog = makeCatalog([a, b]);

    // Default threshold (3): 2 packages → no aggregate, no per-instance (size floor).
    expect(evaluate(catalog, buildIndexes(catalog), {})).toHaveLength(0);

    // Lowered to 2: exactly one aggregate signal.
    const lowered = evaluate(catalog, buildIndexes(catalog), {
      minCrossPackageDuplicatePackages: 2,
    });
    const agg = aggregates(lowered);
    expect(agg).toHaveLength(1);
    expect(agg[0]?.metadata.packages).toEqual(['pkg-a', 'pkg-b']);
    expect(perInstance(lowered)).toHaveLength(0);
  });

  it('does not double-report: a large body in 3 packages → one aggregate, not aggregate + per-instance', () => {
    // Large body (clears default size + line floor) so the per-instance path
    // WOULD fire (2 signals) absent suppression.
    const large = { bodySize: 500, line: 1, endLine: 10 };
    const a = occ({ bodyHash: 'h', simpleName: 'a', package: 'pkg-a', ...large });
    const b = occ({
      bodyHash: 'h',
      simpleName: 'b',
      package: 'pkg-b',
      filePath: 'src/b.ts',
      qualifiedName: 'src/b.b',
      ...large,
    });
    const c = occ({
      bodyHash: 'h',
      simpleName: 'c',
      package: 'pkg-c',
      filePath: 'src/c.ts',
      qualifiedName: 'src/c.c',
      ...large,
    });
    const catalog = makeCatalog([a, b, c]);
    const signals = evaluate(catalog, buildIndexes(catalog), {});
    expect(aggregates(signals)).toHaveLength(1);
    expect(perInstance(signals)).toHaveLength(0);
    expect(signals).toHaveLength(1);
  });

  it('excludes inTestFile occurrences from the aggregate path', () => {
    const small = { bodySize: 50, line: 1, endLine: 2, inTestFile: true };
    const a = occ({ bodyHash: 'h', simpleName: 'a', package: 'pkg-a', ...small });
    const b = occ({
      bodyHash: 'h',
      simpleName: 'b',
      package: 'pkg-b',
      filePath: 'src/b.test.ts',
      ...small,
    });
    const c = occ({
      bodyHash: 'h',
      simpleName: 'c',
      package: 'pkg-c',
      filePath: 'src/c.test.ts',
      ...small,
    });
    const catalog = makeCatalog([a, b, c]);
    expect(evaluate(catalog, buildIndexes(catalog), {})).toHaveLength(0);
  });

  it('excludes arrow / function-expression / module-init kinds from the aggregate path', () => {
    const small = { bodySize: 50, line: 1, endLine: 2 };
    const a = occ({ bodyHash: 'h', simpleName: 'a', kind: 'arrow', package: 'pkg-a', ...small });
    const b = occ({
      bodyHash: 'h',
      simpleName: 'b',
      kind: 'function-expression',
      package: 'pkg-b',
      filePath: 'src/b.ts',
      ...small,
    });
    const c = occ({
      bodyHash: 'h',
      simpleName: 'c',
      kind: 'module-init',
      package: 'pkg-c',
      filePath: 'src/c.ts',
      ...small,
    });
    const catalog = makeCatalog([a, b, c]);
    expect(evaluate(catalog, buildIndexes(catalog), {})).toHaveLength(0);
  });

  it('buckets legacy catalogs (no package) via pkgOf path fallback', () => {
    // No `package` stamp → pkgOf falls back to packageOf(filePath), the
    // packages/<segment>/ heuristic. Three distinct segments → 3 packages.
    const small = { bodySize: 50, line: 1, endLine: 2, package: undefined };
    const a = occ({
      bodyHash: 'h',
      simpleName: 'a',
      filePath: 'packages/lang-typescript/src/a.ts',
      qualifiedName: 'packages/lang-typescript/src/a.a',
      ...small,
    });
    const b = occ({
      bodyHash: 'h',
      simpleName: 'b',
      filePath: 'packages/lang-python/src/b.ts',
      qualifiedName: 'packages/lang-python/src/b.b',
      ...small,
    });
    const c = occ({
      bodyHash: 'h',
      simpleName: 'c',
      filePath: 'packages/lang-go/src/c.ts',
      qualifiedName: 'packages/lang-go/src/c.c',
      ...small,
    });
    const catalog = makeCatalog([a, b, c]);
    const signals = evaluate(catalog, buildIndexes(catalog), {});
    const agg = aggregates(signals);
    expect(agg).toHaveLength(1);
    expect(agg[0]?.metadata.packages).toEqual(['lang-go', 'lang-python', 'lang-typescript']);
    expect(agg[0]?.metadata.packageCount).toBe(3);
    expect(perInstance(signals)).toHaveLength(0);
  });
});
