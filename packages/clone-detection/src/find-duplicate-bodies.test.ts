import { describe, expect, it } from 'vitest';

import { findDuplicateBodies } from './find-duplicate-bodies.js';

import type { CloneCandidate } from './types.js';

function cand(
  partial: Partial<CloneCandidate> & Pick<CloneCandidate, 'bodyHash' | 'filePath' | 'line'>,
): CloneCandidate {
  return {
    bodyHash: partial.bodyHash,
    kind: partial.kind ?? 'function-declaration',
    inTestFile: partial.inTestFile ?? false,
    filePath: partial.filePath,
    line: partial.line,
    column: partial.column ?? 0,
    endLine: partial.endLine ?? partial.line + 10,
    simpleName: partial.simpleName ?? 'fn',
    qualifiedName: partial.qualifiedName ?? partial.simpleName ?? 'fn',
    bodySize: partial.bodySize ?? 300,
    bodyLines: partial.bodyLines ?? 10,
    ...(partial.package === undefined ? {} : { package: partial.package }),
    ...(partial.language === undefined ? {} : { language: partial.language }),
    ...(partial.bodySignature === undefined ? {} : { bodySignature: partial.bodySignature }),
  };
}

describe('findDuplicateBodies policy branches', () => {
  const hash = 'abc123';

  it('excludes test-file occurrences', () => {
    const { groups } = findDuplicateBodies([
      cand({ bodyHash: hash, filePath: 'a.ts', line: 1, inTestFile: true }),
      cand({ bodyHash: hash, filePath: 'b.ts', line: 2, inTestFile: true }),
    ]);
    expect(groups).toEqual([]);
  });

  it('excludes bodies below the line floor', () => {
    const { groups } = findDuplicateBodies([
      cand({ bodyHash: hash, filePath: 'a.ts', line: 1, bodyLines: 3 }),
      cand({ bodyHash: hash, filePath: 'b.ts', line: 2, bodyLines: 3 }),
    ]);
    expect(groups).toEqual([]);
  });

  it('excludes bodies below the per-instance char floor', () => {
    const { groups } = findDuplicateBodies([
      cand({ bodyHash: hash, filePath: 'a.ts', line: 1, bodySize: 100 }),
      cand({ bodyHash: hash, filePath: 'b.ts', line: 2, bodySize: 100 }),
    ]);
    expect(groups).toEqual([]);
  });

  it('excludes ineligible kinds (arrow)', () => {
    const { groups } = findDuplicateBodies([
      cand({ bodyHash: hash, filePath: 'a.ts', line: 1, kind: 'arrow' }),
      cand({ bodyHash: hash, filePath: 'b.ts', line: 2, kind: 'arrow' }),
    ]);
    expect(groups).toEqual([]);
  });

  it('dedupes physical identity within a hash bucket', () => {
    const twin = cand({
      bodyHash: hash,
      filePath: 'a.ts',
      line: 1,
      simpleName: 'a',
      qualifiedName: 'a',
    });
    const { groups } = findDuplicateBodies([twin, { ...twin }]);
    expect(groups).toEqual([]);
  });

  it('emits per-instance duplicate groups for eligible bodies', () => {
    const { groups } = findDuplicateBodies([
      cand({ bodyHash: hash, filePath: 'a.ts', line: 1, qualifiedName: 'a' }),
      cand({ bodyHash: hash, filePath: 'b.ts', line: 2, qualifiedName: 'b' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.members.map((m) => `${m.filePath}:${String(m.line)}`).sort()).toEqual([
      'a.ts:1',
      'b.ts:2',
    ]);
  });

  it('emits cross-package aggregates at minPackages 3 with lighter body-size floor', () => {
    const mediumHash = 'medium-cross-pkg';
    const { aggregates, groups } = findDuplicateBodies([
      cand({
        bodyHash: mediumHash,
        filePath: 'pkg-a/a.ts',
        line: 1,
        package: '@scope/a',
        bodySize: 100,
      }),
      cand({
        bodyHash: mediumHash,
        filePath: 'pkg-b/b.ts',
        line: 1,
        package: '@scope/b',
        bodySize: 100,
      }),
      cand({
        bodyHash: mediumHash,
        filePath: 'pkg-c/c.ts',
        line: 1,
        package: '@scope/c',
        bodySize: 100,
      }),
    ]);
    expect(aggregates).toHaveLength(1);
    expect([...(aggregates[0]?.packages ?? [])].sort()).toEqual([
      '@scope/a',
      '@scope/b',
      '@scope/c',
    ]);
    expect(groups).toEqual([]);
  });

  it('skips cross-package aggregates below the 80-char floor', () => {
    const tinyHash = 'tiny';
    const { aggregates } = findDuplicateBodies([
      cand({ bodyHash: tinyHash, filePath: 'a.ts', line: 1, package: 'a', bodySize: 50 }),
      cand({ bodyHash: tinyHash, filePath: 'b.ts', line: 1, package: 'b', bodySize: 50 }),
      cand({ bodyHash: tinyHash, filePath: 'c.ts', line: 1, package: 'c', bodySize: 50 }),
    ]);
    expect(aggregates).toEqual([]);
  });
});
