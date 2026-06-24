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

/**
 * Signature ALGORITHM version. Bump on ANY change to shingling, hashing, or the
 * permutation scheme that alters signature VALUES. Feeds the `sig=` cache-key
 * segment so catalogs built with an older algorithm invalidate — mixing old- and
 * new-algorithm signatures across an incremental build (some occurrences cached,
 * some re-walked) would corrupt every cross-occurrence Jaccard estimate.
 *
 * v1 = k independent SHA-256 hashes per (shingle, seed). v2 = one SHA-256 base
 * hash per shingle + k cheap 32-bit mixers (~k× fewer hashes, identical MinHash
 * semantics).
 */
export const NEAR_DUP_SIGNATURE_VERSION = 2;

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
 * Deterministic MinHash signature over char shingles. Stable across runs and
 * machines (SHA-256 base hash + fixed permutation seeds).
 *
 * Each shingle is hashed ONCE with SHA-256 (the only expensive step); the k
 * MinHash values are then derived by mixing that base hash with k fixed 32-bit
 * seeds. This is ~k× fewer SHA-256 computations than hashing every
 * (shingle, seed) pair while preserving MinHash semantics (each of the k mixers
 * is an independent hash of the shingle universe, so the per-position min
 * estimates Jaccard exactly as before). Algorithm {@link NEAR_DUP_SIGNATURE_VERSION}.
 */
export function bodySignature(canonical: string, k = NEAR_DUP_SIGNATURE_K): readonly number[] {
  const shingles = shingle(canonical);
  if (shingles.size === 0) return [];
  const seeds = k === NEAR_DUP_SIGNATURE_K ? PERM_SEEDS : derivePermSeeds(k);
  // Hash each shingle exactly once — the per-(shingle, seed) k-fold SHA-256 of
  // the v1 algorithm is the cost this removes.
  const bases: number[] = [];
  for (const gram of shingles) bases.push(baseHash(gram));
  const sig: number[] = [];
  for (let i = 0; i < k; i++) {
    const seed = seeds[i] ?? 0;
    let min = 0xff_ff_ff_ff;
    for (const base of bases) {
      const v = mix32(base, seed);
      if (v < min) min = v;
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

/** SHA-256 → 32-bit base hash of one shingle (computed once per shingle). */
function baseHash(gram: string): number {
  return createHash('sha256').update(gram, 'utf8').digest().readUInt32LE(0);
}

/**
 * Cheap 32-bit avalanche of a base hash under one permutation seed (Mueller's
 * integer finalizer). Division-free, no precision loss — `Math.imul` keeps the
 * multiply in 32-bit. Distinct seeds yield independent hashes of the shingle.
 */
function mix32(h: number, seed: number): number {
  const MIX_CONST = 0x4_5d_9f_3b;
  let x = (h ^ seed) >>> 0;
  x = Math.imul((x >>> 16) ^ x, MIX_CONST) >>> 0;
  x = Math.imul((x >>> 16) ^ x, MIX_CONST) >>> 0;
  return ((x >>> 16) ^ x) >>> 0;
}

/** k fixed permutation seeds, derived deterministically (SHA-256 of the index). */
function derivePermSeeds(k: number): readonly number[] {
  return Array.from({ length: k }, (_, i) =>
    createHash('sha256')
      .update(`opensip-minhash-perm:${String(i)}`, 'utf8')
      .digest()
      .readUInt32LE(0),
  );
}

const PERM_SEEDS: readonly number[] = derivePermSeeds(NEAR_DUP_SIGNATURE_K);
