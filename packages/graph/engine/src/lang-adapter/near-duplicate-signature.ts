/**
 * Near-duplicate body signatures — MinHash + LSH primitives.
 *
 * Single source of truth for signature constants and the digest tail used by
 * both tree-sitter adapters and the TypeScript inventory path. Signatures are
 * derived from the same canonical body string that feeds `bodyHash`.
 */

import { createHash } from 'node:crypto';

import { hashBody, type BodyDigest } from './body-digest.js';

/** Number of MinHash values per body signature. */
export const NEAR_DUP_SIGNATURE_K = 128;

/** Default LSH band count — co-tuned with {@link NEAR_DUP_LSH_ROWS}. */
export const NEAR_DUP_LSH_BANDS = 8;

/** Rows per band; `bands × rows === k`. Knee ≈ 0.878 at threshold 0.85. */
export const NEAR_DUP_LSH_ROWS = 16;

/** Digest including hash, size, and optional near-duplicate MinHash signature. */
export type BodyDigestWithSignature = BodyDigest;

/**
 * Character k-grams from canonical body text. Bodies shorter than `gramSize`
 * yield a single shingle of the whole string when non-empty.
 */
export function shingle(canonical: string, gramSize = 5): ReadonlySet<string> {
  const set = new Set<string>();
  if (canonical.length === 0) return set;
  if (canonical.length < gramSize) {
    set.add(canonical);
    return set;
  }
  for (let i = 0; i <= canonical.length - gramSize; i++) {
    set.add(canonical.slice(i, i + gramSize));
  }
  return set;
}

/**
 * Deterministic MinHash signature over char shingles. Stable across runs
 * (seeded per hash-function index).
 */
export function bodySignature(canonical: string, k = NEAR_DUP_SIGNATURE_K): readonly number[] {
  const shingles = shingle(canonical);
  if (shingles.size === 0) return [];
  const sig: number[] = [];
  for (let seed = 0; seed < k; seed++) {
    let min = Number.MAX_SAFE_INTEGER;
    for (const gram of shingles) {
      const h = hashShingle(gram, seed);
      if (h < min) min = h;
    }
    sig.push(min);
  }
  return sig;
}

/** MinHash Jaccard estimate: equal-position fraction. */
export function estimateJaccard(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let matches = 0;
  for (const [i, element] of a.entries()) {
    if (element === b[i]) matches++;
  }
  return matches / a.length;
}

/** LSH band hashes for candidate-pair generation. */
export function lshBandHashes(
  signature: readonly number[],
  bands: number,
  rows: number,
): readonly string[] {
  const out: string[] = [];
  for (let band = 0; band < bands; band++) {
    const start = band * rows;
    out.push(signature.slice(start, start + rows).join(','));
  }
  return out;
}

/**
 * Hash + size + signature for an already-normalized canonical body string.
 * Skips `signature` when the canonical text yields no shingles.
 */
export function digestCanonicalBody(canonical: string): BodyDigestWithSignature {
  const digest = hashBody(canonical);
  const signature = bodySignature(canonical);
  return {
    ...digest,
    signature: signature.length > 0 ? signature : undefined,
  };
}

function hashShingle(gram: string, seed: number): number {
  const buf = createHash('sha256')
    .update(`${String(seed)}:${gram}`, 'utf8')
    .digest();
  return buf.readUInt32LE(0);
}
