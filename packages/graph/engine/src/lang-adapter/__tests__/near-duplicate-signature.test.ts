import { describe, expect, it } from 'vitest';

import {
  NEAR_DUP_LSH_BANDS,
  NEAR_DUP_LSH_ROWS,
  NEAR_DUP_SIGNATURE_K,
  bodySignature,
  digestCanonicalBody,
  estimateJaccard,
  lshBandHashes,
  shingle,
} from '../near-duplicate-signature.js';

describe('near-duplicate-signature', () => {
  const base =
    'function processItems(items) { const out = []; for (const item of items) { out.push(transform(item)); } return out; }';
  const nearEdit =
    'function processItems(items) { const result = []; for (const item of items) { result.push(transform(item)); } return result; }';
  const unrelated =
    'export function validateConfig(cfg) { if (!cfg.apiKey) throw new Error("missing"); return cfg; }';

  it('identical canonical text yields Jaccard 1.0', () => {
    const a = bodySignature(base);
    const b = bodySignature(base);
    expect(estimateJaccard(a, b)).toBe(1);
  });

  it('one-token edit yields high but sub-1.0 Jaccard', () => {
    const j = estimateJaccard(bodySignature(base), bodySignature(nearEdit));
    expect(j).toBeGreaterThan(0.5);
    expect(j).toBeLessThan(1);
  });

  it('unrelated bodies yield low Jaccard', () => {
    expect(estimateJaccard(bodySignature(base), bodySignature(unrelated))).toBeLessThan(0.5);
  });

  it('signatures are stable across runs', () => {
    expect(bodySignature(base)).toEqual(bodySignature(base));
  });

  it('bands × rows equals k', () => {
    expect(NEAR_DUP_LSH_BANDS * NEAR_DUP_LSH_ROWS).toBe(NEAR_DUP_SIGNATURE_K);
  });

  it('LSH knee is near the 0.85 threshold', () => {
    const knee = (1 / NEAR_DUP_LSH_BANDS) ** (1 / NEAR_DUP_LSH_ROWS);
    expect(knee).toBeCloseTo(0.878, 2);
  });

  it('shingle emits char 5-grams', () => {
    expect(shingle('abcdef').size).toBe(2);
    expect(shingle('ab').size).toBe(1);
    expect(shingle('').size).toBe(0);
  });

  it('digestCanonicalBody returns hash, size, and signature', () => {
    const d = digestCanonicalBody(base);
    expect(d.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(d.size).toBeGreaterThan(0);
    expect(d.signature?.length).toBe(NEAR_DUP_SIGNATURE_K);
  });

  it('lshBandHashes returns one hash per band', () => {
    const sig = bodySignature(base);
    expect(lshBandHashes(sig, NEAR_DUP_LSH_BANDS, NEAR_DUP_LSH_ROWS).length).toBe(
      NEAR_DUP_LSH_BANDS,
    );
  });

  it('bodySignature returns empty for empty canonical (no shingles)', () => {
    expect(bodySignature('')).toEqual([]);
  });

  it('bodySignature with custom k derives k seeds and returns k values', () => {
    const sig = bodySignature(base, 32);
    expect(sig.length).toBe(32);
    // Custom-k path is deterministic and stable across calls.
    expect(bodySignature(base, 32)).toEqual(sig);
    // Identical body still self-matches under a custom k.
    expect(estimateJaccard(sig, bodySignature(base, 32))).toBe(1);
  });

  it('bodySignature produces a full-width signature for sub-gram bodies', () => {
    // Body shorter than the gram size yields a single whole-string shingle,
    // exercising the single-base MinHash loop across all k positions.
    const short = bodySignature('ab');
    expect(short.length).toBe(NEAR_DUP_SIGNATURE_K);
    expect(short.every((v) => Number.isInteger(v))).toBe(true);
  });

  it('estimateJaccard returns 0 when either signature is empty', () => {
    const sig = bodySignature(base);
    expect(estimateJaccard([], sig)).toBe(0);
    expect(estimateJaccard(sig, [])).toBe(0);
    expect(estimateJaccard([], [])).toBe(0);
  });

  it('estimateJaccard returns 0 for mismatched signature lengths', () => {
    expect(estimateJaccard(bodySignature(base), bodySignature(base, 32))).toBe(0);
  });

  it('digestCanonicalBody omits signature for empty canonical', () => {
    const d = digestCanonicalBody('');
    expect(d.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(d.signature).toBeUndefined();
  });
});
