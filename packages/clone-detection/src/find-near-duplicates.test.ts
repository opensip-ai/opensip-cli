import { describe, expect, it } from 'vitest';

import { findNearDuplicates } from './find-near-duplicates.js';
import { bodySignature, digestCanonicalBody, estimateJaccard } from './near-duplicate-signature.js';

import type { CloneCandidate } from './types.js';

function signedCand(
  canonical: string,
  filePath: string,
  line: number,
  language = 'typescript',
): CloneCandidate {
  const d = digestCanonicalBody(canonical);
  return {
    bodyHash: d.hash,
    bodySignature: d.signature,
    bodySize: d.size,
    bodyLines: 10,
    kind: 'function-declaration',
    inTestFile: false,
    filePath,
    line,
    column: 0,
    endLine: line + 10,
    simpleName: 'fn',
    qualifiedName: `mod.fn`,
    language,
  };
}

describe('findNearDuplicates', () => {
  const payload = 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(12);
  const baseBody = `function work(items) { const payload = "${payload}"; let total = 0; for (const item of items) { total += item.length + payload.length; } return total; }`;
  const nearBody = `function work(items) { const payload = "${payload}"; let total = 0; for (const item of items) { total += item.length + payload.length + 1; } return total; }`;
  const unrelated =
    'export function validateConfig(cfg) { if (!cfg.apiKey) throw new Error("missing"); return cfg; }';

  it('clusters near-identical bodies above the similarity threshold', () => {
    expect(
      estimateJaccard(bodySignature(baseBody), bodySignature(nearBody)),
    ).toBeGreaterThanOrEqual(0.85);
    const clusters = findNearDuplicates([
      signedCand(baseBody, 'a.ts', 1),
      signedCand(nearBody, 'b.ts', 2),
    ]);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    expect(clusters[0]?.clusterSize).toBeGreaterThanOrEqual(2);
  });

  it('does not cluster unrelated bodies', () => {
    const clusters = findNearDuplicates([
      signedCand(baseBody, 'a.ts', 1),
      signedCand(unrelated, 'b.ts', 2),
    ]);
    expect(clusters).toEqual([]);
  });

  it('does not cluster across languages', () => {
    const clusters = findNearDuplicates([
      signedCand(baseBody, 'a.ts', 1, 'typescript'),
      signedCand(nearBody, 'b.rs', 2, 'rust'),
    ]);
    expect(clusters).toEqual([]);
  });

  it('bodySignature is stable (golden sanity)', () => {
    expect(bodySignature(baseBody)).toEqual(bodySignature(baseBody));
  });
});
