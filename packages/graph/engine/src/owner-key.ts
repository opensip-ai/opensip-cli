/**
 * Edge-owner key.
 *
 * Call/dependency edges are bucketed by their owning occurrence while edges are
 * resolved, then stitched back onto occurrences. The owner cannot be keyed by
 * `bodyHash` alone: two functions with identical bodies in different files
 * (e.g. `stripStrings` duplicated across the language adapters) share a hash,
 * so a hash-keyed bucket unions their edges — each twin then appears to call
 * every twin's callees, inventing cross-package coupling.
 *
 * `(bodyHash, filePath)` still collides, though: a bodyHash can appear TWICE in
 * ONE file — two byte-identical arrows on a single source line, distinguished
 * only by column (`a.some((p) => p.test(x)) || b.some((p) => p.test(x))`). Under
 * the 2-tuple key those same-file twins unioned their edges too. The key is
 * therefore FULL occurrence identity — `(bodyHash, filePath, line, column)`, the
 * same tuple `Indexes.byOccId` (`filePath:line:column`) and the mergeShardFragments
 * occurrence dedup use — so no two distinct occurrences ever share a bucket
 * (ADR-0136, refining ADR-0003).
 *
 * The `filePath`/`line`/`column` components must be byte-identical to the
 * `FunctionOccurrence` fields (project-relative path + 1-based line + 0-based
 * column, as the walk emits them) so the stitch lookup hits. The NUL separator
 * never appears in a body hash (hex), a file path, or a decimal line/column.
 */

const SEP = String.fromCodePoint(0);

/**
 * The per-occurrence key edges are bucketed under: `bodyHash`, the occurrence's
 * project-relative `filePath`, its 1-based `line`, and its 0-based `column`,
 * joined by a NUL separator. Full occurrence identity distinguishes body-twins
 * both ACROSS files (different `filePath`) and WITHIN one file (same
 * `filePath`/`line`, different `column`) so their edges are never unioned.
 */
export function ownerEdgeKey(
  bodyHash: string,
  filePath: string,
  line: number,
  column: number,
): string {
  return bodyHash + SEP + filePath + SEP + String(line) + SEP + String(column);
}
