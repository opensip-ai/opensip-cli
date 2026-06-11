/**
 * Aggregate cross-package code path for the duplicated-function-body rule.
 *
 * Validates the second, package-spread code path: a body hash present in
 * ≥ minCrossPackageDuplicatePackages DISTINCT packages (via pkgOf) — that
 * also clears the same size floor as the per-instance path — emits ONE
 * aggregate signal and suppresses the per-instance signals for that hash.
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
  /** A body that clears the default size floor (≥ 5 lines, ≥ 200 chars). */
  const substantial = { bodySize: 500, line: 1, endLine: 10 };

  it('fires exactly one aggregate signal for a substantial body in 3 packages', () => {
    const a = occ({ bodyHash: 'h', simpleName: 'stripStrings', package: 'pkg-c', ...substantial });
    const b = occ({
      bodyHash: 'h',
      simpleName: 'stripStrings',
      package: 'pkg-a',
      filePath: 'src/b.ts',
      qualifiedName: 'src/b.stripStrings',
      ...substantial,
    });
    const c = occ({
      bodyHash: 'h',
      simpleName: 'stripStrings',
      package: 'pkg-b',
      filePath: 'src/c.ts',
      qualifiedName: 'src/c.stripStrings',
      ...substantial,
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
    // Anchored at lexicographically-lowest qualifiedName.
    // qualifiedNames are: src/a.stripStrings, src/b.stripStrings, src/c.stripStrings.
    expect(s?.code?.file).toBe('src/a.ts');
  });

  it('does NOT fire for a TRIVIAL body across packages (size floor)', () => {
    // A tiny body (50 chars / 2 lines) — an empty DI shim, one-line getter,
    // thin delegator — is below the size floor, so the aggregate path skips it
    // even though it spans 3 packages (and the per-instance path is floored too).
    const trivial = { bodySize: 50, line: 1, endLine: 2 };
    const a = occ({ bodyHash: 'h', simpleName: 'get', package: 'pkg-a', ...trivial });
    const b = occ({
      bodyHash: 'h',
      simpleName: 'get',
      package: 'pkg-b',
      filePath: 'src/b.ts',
      qualifiedName: 'src/b.get',
      ...trivial,
    });
    const c = occ({
      bodyHash: 'h',
      simpleName: 'get',
      package: 'pkg-c',
      filePath: 'src/c.ts',
      qualifiedName: 'src/c.get',
      ...trivial,
    });
    const catalog = makeCatalog([a, b, c]);
    expect(evaluate(catalog, buildIndexes(catalog), {})).toHaveLength(0);
  });

  it('DOES fire for a small-but-non-trivial body (between the aggregate and per-instance floors)', () => {
    // 120 chars / 2 lines: above the aggregate floor (80) but below the
    // per-instance floor (200). The per-instance path would stay silent; the
    // aggregate path catches it — its whole purpose (small shared utility
    // copied across packages).
    const smallReal = { bodySize: 120, line: 1, endLine: 2 };
    const a = occ({ bodyHash: 'h', simpleName: 'parseRange', package: 'pkg-a', ...smallReal });
    const b = occ({
      bodyHash: 'h',
      simpleName: 'parseRange',
      package: 'pkg-b',
      filePath: 'src/b.ts',
      qualifiedName: 'src/b.parseRange',
      ...smallReal,
    });
    const c = occ({
      bodyHash: 'h',
      simpleName: 'parseRange',
      package: 'pkg-c',
      filePath: 'src/c.ts',
      qualifiedName: 'src/c.parseRange',
      ...smallReal,
    });
    const catalog = makeCatalog([a, b, c]);
    const signals = evaluate(catalog, buildIndexes(catalog), {});
    expect(aggregates(signals)).toHaveLength(1);
    expect(perInstance(signals)).toHaveLength(0);
  });

  it('honors a custom minCrossPackageDuplicateBodySize override', () => {
    const body90 = { bodySize: 90, line: 1, endLine: 2 };
    const a = occ({ bodyHash: 'h', simpleName: 'a', package: 'pkg-a', ...body90 });
    const b = occ({
      bodyHash: 'h',
      simpleName: 'b',
      package: 'pkg-b',
      filePath: 'src/b.ts',
      qualifiedName: 'src/b.b',
      ...body90,
    });
    const c = occ({
      bodyHash: 'h',
      simpleName: 'c',
      package: 'pkg-c',
      filePath: 'src/c.ts',
      qualifiedName: 'src/c.c',
      ...body90,
    });
    const catalog = makeCatalog([a, b, c]);
    // Default floor (80): 90 ≥ 80 → fires.
    expect(aggregates(evaluate(catalog, buildIndexes(catalog), {}))).toHaveLength(1);
    // Raised to 100: 90 < 100 → suppressed.
    expect(
      evaluate(catalog, buildIndexes(catalog), { minCrossPackageDuplicateBodySize: 100 }),
    ).toHaveLength(0);
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
    const a = occ({ bodyHash: 'h', simpleName: 'a', package: 'pkg-a', ...substantial });
    const b = occ({
      bodyHash: 'h',
      simpleName: 'b',
      package: 'pkg-b',
      filePath: 'src/b.ts',
      qualifiedName: 'src/b.b',
      ...substantial,
    });
    const catalog = makeCatalog([a, b]);

    // Default threshold (3): 2 packages → no aggregate. The body clears the
    // size floor, so the per-instance path reports it instead (1 signal).
    const def = evaluate(catalog, buildIndexes(catalog), {});
    expect(aggregates(def)).toHaveLength(0);
    expect(perInstance(def)).toHaveLength(1);

    // Lowered to 2: exactly one aggregate signal (and no per-instance double).
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
    const legacy = { bodySize: 500, line: 1, endLine: 10, package: undefined };
    const a = occ({
      bodyHash: 'h',
      simpleName: 'a',
      filePath: 'packages/lang-typescript/src/a.ts',
      qualifiedName: 'packages/lang-typescript/src/a.a',
      ...legacy,
    });
    const b = occ({
      bodyHash: 'h',
      simpleName: 'b',
      filePath: 'packages/lang-python/src/b.ts',
      qualifiedName: 'packages/lang-python/src/b.b',
      ...legacy,
    });
    const c = occ({
      bodyHash: 'h',
      simpleName: 'c',
      filePath: 'packages/lang-go/src/c.ts',
      qualifiedName: 'packages/lang-go/src/c.c',
      ...legacy,
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
