/**
 * Edge-owner key.
 *
 * Call/dependency edges are bucketed by their owning occurrence while edges are
 * resolved, then stitched back onto occurrences. The owner cannot be keyed by
 * `bodyHash` alone: two functions with identical bodies in different files
 * (e.g. `stripStrings` duplicated across the language adapters) share a hash,
 * so a hash-keyed bucket unions their edges — each twin then appears to call
 * every twin's callees, inventing cross-package coupling. Keying by
 * `(bodyHash, filePath)` keeps each occurrence's edges its own.
 *
 * The `filePath` component must be byte-identical to `FunctionOccurrence.filePath`
 * (project-relative, as the walk emits it) so the stitch lookup hits. The NUL
 * separator never appears in a body hash (hex) or a file path.
 */

const SEP = String.fromCodePoint(0);

/**
 * The per-occurrence key edges are bucketed under: `bodyHash` joined with the
 * occurrence's project-relative `filePath` by a NUL separator. Distinguishes
 * body-twins (identical bodies in different files) so their edges aren't unioned.
 */
export function ownerEdgeKey(bodyHash: string, filePath: string): string {
  return bodyHash + SEP + filePath;
}
