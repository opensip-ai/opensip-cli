import { describe, expect, it } from 'vitest';

import { findNearDuplicates } from './find-near-duplicates.js';
import {
  bodySignature,
  digestCanonicalBody,
  estimateJaccard,
  lshBandHashes,
  shingle,
} from './near-duplicate-signature.js';

import type { CloneCandidate } from './types.js';

function signature(valueFor: (index: number) => number = (index) => index): readonly number[] {
  return Array.from({ length: 128 }, (_, index) => valueFor(index));
}

type CandidateInput = Omit<Partial<CloneCandidate>, 'bodySignature'> &
  Pick<CloneCandidate, 'bodyHash'> & {
    readonly bodySignature?: readonly number[] | null;
  };

function cand(partial: CandidateInput): CloneCandidate {
  return {
    bodyHash: partial.bodyHash,
    bodySize: partial.bodySize ?? 300,
    bodyLines: partial.bodyLines ?? 10,
    kind: partial.kind ?? 'function-declaration',
    inTestFile: partial.inTestFile ?? false,
    filePath: partial.filePath ?? 'file.ts',
    line: partial.line ?? 1,
    column: partial.column ?? 0,
    endLine: partial.endLine ?? (partial.line ?? 1) + 10,
    simpleName: partial.simpleName ?? 'fn',
    qualifiedName: partial.qualifiedName ?? partial.simpleName ?? 'fn',
    ...(partial.bodySignature === null
      ? {}
      : { bodySignature: partial.bodySignature ?? signature() }),
    ...(partial.language === undefined ? {} : { language: partial.language }),
  };
}

describe('findNearDuplicates branch behavior', () => {
  it('returns no clusters when the LSH band count cannot evenly partition the signature', () => {
    expect(
      findNearDuplicates(
        [
          cand({ bodyHash: 'a', language: 'typescript' }),
          cand({ bodyHash: 'b', language: 'typescript' }),
        ],
        { lshBands: 7 },
      ),
    ).toEqual([]);
  });

  it('filters candidates without an eligible near-duplicate signature', () => {
    expect(
      findNearDuplicates(
        [
          cand({ bodyHash: 'too-small', bodySize: 10, language: 'typescript' }),
          cand({
            bodyHash: 'missing-signature',
            bodySignature: null,
            language: 'typescript',
          }),
          cand({
            bodyHash: 'wrong-signature-size',
            bodySignature: [1, 2],
            language: 'typescript',
          }),
          cand({ bodyHash: 'arrow', kind: 'arrow', language: 'typescript' }),
          cand({
            bodyHash: 'test-file',
            inTestFile: true,
            language: 'typescript',
          }),
        ],
        { minBodySize: 200 },
      ),
    ).toEqual([]);
  });

  it('skips candidate pairs without a resolved shared language', () => {
    expect(
      findNearDuplicates(
        [
          cand({ bodyHash: 'a', language: 'typescript' }),
          cand({ bodyHash: 'b' }),
          cand({ bodyHash: 'c', language: 'rust' }),
        ],
        { minBodySize: 1 },
      ),
    ).toEqual([]);
  });

  it('skips LSH bucket pairs below the similarity threshold', () => {
    const firstBandOnlyMatch = signature((index) => (index < 16 ? 1 : index));
    const mostlyDifferent = signature((index) => (index < 16 ? 1 : index + 1000));

    expect(
      findNearDuplicates(
        [
          cand({
            bodyHash: 'a',
            bodySignature: firstBandOnlyMatch,
            language: 'typescript',
          }),
          cand({
            bodyHash: 'b',
            bodySignature: mostlyDifferent,
            language: 'typescript',
          }),
        ],
        { minBodySize: 1, minSimilarity: 0.85 },
      ),
    ).toEqual([]);
  });

  it('reports exact members embedded in a connected near-duplicate component', () => {
    const sharedSignature = signature();
    const clusters = findNearDuplicates(
      [
        cand({
          bodyHash: 'same',
          bodySignature: sharedSignature,
          filePath: 'z.ts',
          line: 3,
          qualifiedName: 'z.same',
          language: 'typescript',
        }),
        cand({
          bodyHash: 'bridge',
          bodySignature: sharedSignature,
          filePath: 'm.ts',
          line: 2,
          qualifiedName: 'm.bridge',
          language: 'typescript',
        }),
        cand({
          bodyHash: 'same',
          bodySignature: sharedSignature,
          filePath: 'a.ts',
          line: 1,
          qualifiedName: 'a.same',
          language: 'typescript',
        }),
      ],
      { minBodySize: 1 },
    );

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.anchor.filePath).toBe('a.ts');
    expect(clusters[0]?.estimatedSimilarity).toBe(1);
    expect(clusters[0]?.exactMembers).toEqual(['a.same', 'z.same']);
    expect(clusters[0]?.nearMembers).toEqual(['a.same', 'm.bridge', 'z.same']);
  });

  it('caps oversized clusters instead of dropping them', () => {
    // Build a large near-identical component (> MAX_CLUSTER_SIZE=50) with a
    // shared MinHash signature so every pair connects; expect a capped cluster
    // rather than undefined/empty.
    const sharedSignature = signature();
    const members = Array.from({ length: 60 }, (_, i) =>
      cand({
        bodyHash: `h${String(i)}`,
        bodySignature: sharedSignature,
        filePath: `f${String(i).padStart(3, '0')}.ts`,
        line: 1,
        qualifiedName: `n${String(i).padStart(3, '0')}`,
        language: 'typescript',
      }),
    );
    const clusters = findNearDuplicates(members, { minBodySize: 1 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.clusterSize).toBe(50);
    expect(clusters[0]?.nearMembers.length).toBeLessThanOrEqual(50);
  });
});

describe('near-duplicate signature edge cases', () => {
  it('handles empty and short canonical bodies', () => {
    expect([...shingle('')]).toEqual([]);
    expect([...shingle('abc')]).toEqual(['abc']);
    expect(digestCanonicalBody('').signature).toBeUndefined();
  });

  it('handles incompatible signatures and custom signature sizes', () => {
    expect(estimateJaccard([], [])).toBe(0);
    expect(estimateJaccard([1], [1, 2])).toBe(0);
    expect(lshBandHashes([1, 2, 3, 4], 2, 2)).toEqual(['1,2', '3,4']);
    expect(bodySignature('abcdef', 4)).toHaveLength(4);
  });
});
