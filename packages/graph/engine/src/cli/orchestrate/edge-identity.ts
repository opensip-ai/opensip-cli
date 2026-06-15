/**
 * Shared occurrence/edge IDENTITY — the ONE module that owns how call/dependency
 * edges are keyed to their owning occurrence and stitched back onto it.
 *
 * WHY THIS EXISTS (the drift it closes):
 *   ADR-0003 mandates edges be keyed by OCCURRENCE — `ownerEdgeKey(bodyHash,
 *   filePath)` — not by `bodyHash` alone: two functions with byte-identical
 *   bodies in different files (e.g. `stripStrings` duplicated across the language
 *   adapters) share a hash, so a hash-only bucket UNIONS their edges, inventing
 *   phantom cross-package coupling. The EXACT path complied (its resolver returns
 *   an `ownerEdgeKey`-keyed map; `catalog-builder.stitchEdges` reads it the same
 *   way). The CROSS-SHARD merge did NOT — it bucketed/stitched by `bc.ownerHash`
 *   alone (a second, drifting keying scheme). That drift is the root cause of the
 *   F1 ADR-0003 violation.
 *
 *   This module is the single home of that identity. Both engines import it; no
 *   consumer keys edges by a bare `bodyHash`. The Phase-1 fitness check
 *   (`no-bodyhash-keying-outside-identity`) forbids re-deriving an owner-keyed
 *   edge map anywhere else, so the drift cannot recur.
 *
 * Pure: no fs, no engine state — both engines and the equivalence harness import
 * the same helpers.
 */

import { ownerEdgeKey } from '../../owner-key.js';

import type { CallEdge, FunctionOccurrence } from '../../types.js';

export { ownerEdgeKey } from '../../owner-key.js';

/**
 * Bucket a flat list of edge-bearing items into a `Map<ownerEdgeKey, CallEdge[]>`,
 * keyed via {@link ownerEdgeKey} (NOT by `bodyHash` alone). `keyParts` extracts
 * the owning occurrence's `(bodyHash, filePath)` from each item; `edgeOf`
 * extracts the edge. Append-order within a bucket is preserved (callers sort
 * downstream for determinism). The canonical owner-keyed bucket: every consumer
 * routes through this instead of re-deriving an owner key inline.
 */
export function bucketEdgesByOwner<T>(
  items: Iterable<T>,
  keyParts: (item: T) => { readonly bodyHash: string; readonly filePath: string },
  edgeOf: (item: T) => CallEdge,
): Map<string, CallEdge[]> {
  const byOwner = new Map<string, CallEdge[]>();
  for (const item of items) {
    const { bodyHash, filePath } = keyParts(item);
    const key = ownerEdgeKey(bodyHash, filePath);
    const bucket = byOwner.get(key);
    if (bucket) bucket.push(edgeOf(item));
    else byOwner.set(key, [edgeOf(item)]);
  }
  return byOwner;
}

/**
 * Stitch recovered edges onto each occurrence, keyed by
 * `ownerEdgeKey(o.bodyHash, o.filePath)` so ONLY the owning occurrence receives
 * its edges (body-twins in different files never smear). `combine` decides how an
 * occurrence's existing `calls` and its recovered edges merge (e.g. replace,
 * concatenate, or drop-placeholder-then-concat) and returns the new occurrence —
 * keeping the keying in one place while leaving the per-engine merge policy to
 * the caller. An occurrence with no recovered edges is returned unchanged.
 */
export function stitchEdgesByOwner(
  functions: Readonly<Record<string, readonly FunctionOccurrence[]>>,
  edgesByOwnerKey: ReadonlyMap<string, readonly CallEdge[]>,
  combine: (occ: FunctionOccurrence, recovered: readonly CallEdge[]) => FunctionOccurrence,
): Record<string, readonly FunctionOccurrence[]> {
  const out: Record<string, readonly FunctionOccurrence[]> = Object.create(null) as Record<
    string,
    readonly FunctionOccurrence[]
  >;
  for (const [name, occs] of Object.entries(functions)) {
    if (!occs) continue;
    out[name] = occs.map((o) => {
      const recovered = edgesByOwnerKey.get(ownerEdgeKey(o.bodyHash, o.filePath));
      return recovered === undefined || recovered.length === 0 ? o : combine(o, recovered);
    });
  }
  return out;
}
