/**
 * Catalog-derived progress-detail metrics, shared by the single-program
 * (exact) and sharded build paths so both compute the SAME stage-detail
 * metric the SAME way from their final catalog — one consistent
 * "N call site(s)" / "N functions" row regardless of engine, with no
 * engine-specific (e.g. "cross-shard") leakage.
 *
 * NOTE: the two engines' occurrence sets are equivalent, but their resolved
 * call-edge sets currently differ (the sharded path's boundary recovery adds
 * cross-shard edges the single-program path resolves differently) — that
 * edge-set divergence is a separate engine concern, not this metric's. These
 * helpers faithfully report whatever the catalog they're handed contains.
 */

import type { Catalog } from '../../types.js';

/**
 * Distinct function occurrences in a catalog — the merged `walk` sub-label
 * count. Sums occurrence arrays across all function names.
 */
export function countCatalogFunctions(catalog: Catalog): number {
  let n = 0;
  for (const name of Object.keys(catalog.functions)) {
    const occs = catalog.functions[name];
    if (occs) n += occs.length;
  }
  return n;
}

/**
 * RESOLVED call sites across all occurrences — the `resolve` sub-label count.
 * Counts only call edges that resolved to at least one target (`to.length > 0`),
 * NOT empty-`to` placeholder edges (which the sharded boundary pass emits per
 * unresolved cross-shard call site and which would otherwise inflate the sharded
 * number by ~100k vs exact). Counting resolved edges makes the metric meaningful
 * ("call sites we drew an edge for") and engine-consistent: post-convergence the
 * exact and sharded builds report near-identical counts (a small residual remains
 * from documented cross-package re-export differences).
 */
export function countCatalogCallSites(catalog: Catalog): number {
  let n = 0;
  for (const name of Object.keys(catalog.functions)) {
    const occs = catalog.functions[name];
    if (!occs) continue;
    for (const occ of occs) {
      for (const edge of occ.calls) if (edge.to.length > 0) n++;
    }
  }
  return n;
}
