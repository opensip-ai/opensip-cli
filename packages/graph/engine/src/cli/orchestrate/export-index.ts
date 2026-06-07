/**
 * Linker data structures for semantic cross-shard resolution (plan #2, Phase 1).
 *
 * Pure "symbol tables" the boundary resolver (Phase 2) links against, derivable
 * entirely from data already present in a merged catalog. This file's first
 * structure is the {@link ExportIndex} — a per-package map of exported function
 * name → occurrences (`visibility === 'exported'`): "given a package and a
 * callee name, which exported occurrences match?"
 *
 * Engine-layer and language-agnostic: no TypeScript parser, no AST — plain
 * map/path math. UNUSED by resolution logic in Phase 1; Phase 2 wires it into
 * `resolveCrossBoundaryCalls`.
 *
 * Package-key alignment (the linchpin Phase 2 depends on): the boundary
 * resolver buckets occurrences by `packageOf(occ.filePath)` — the path segment
 * under `packages/` (e.g. `core`, `graph`, `languages`), NOT the package.json
 * `name`. So {@link buildExportIndex} keys by exactly that.
 */

import { packageOf } from '../../resolve-callee.js';

import type { Catalog, FunctionOccurrence } from '../../types.js';

// ── Task 1.1: per-package export symbol index ─────────────────────

/**
 * Per-package export symbol table: `package` → (`name` → exported occurrences).
 *
 * The outer key is `packageOf(filePath)` (the `packages/<segment>` group),
 * matching the bucketing the boundary resolver uses; the inner key is a
 * function's `simpleName`. Only `visibility === 'exported'` occurrences are
 * present — module-local and private occurrences are excluded, since an import
 * specifier can only reach a package's exports.
 *
 * Insertion order follows catalog iteration. Consumers MUST match by name, not
 * order; the inner arrays are the deterministic candidate set for a name.
 */
export type ExportIndex = ReadonlyMap<
  string /* package */,
  ReadonlyMap<string /* name */, readonly FunctionOccurrence[]>
>;

/**
 * Bucket every exported occurrence in `catalog` by its package group then by
 * its simple name. Deterministic and allocation-lean: one pass over
 * `catalog.functions`, no sorting (matching is by name, not order).
 *
 * The package key is `packageOf(occ.filePath)` — identical to what the
 * cross-shard resolver buckets by — so Phase 2 can look up
 * `exportIndex.get(packageGroup)`.
 */
export function buildExportIndex(catalog: Catalog): ExportIndex {
  const index = new Map<string, Map<string, FunctionOccurrence[]>>();
  for (const occs of Object.values(catalog.functions)) {
    if (!occs) continue;
    for (const occ of occs) {
      if (occ.visibility !== 'exported') continue;
      const pkg = packageOf(occ.filePath);
      let byName = index.get(pkg);
      if (byName === undefined) {
        byName = new Map<string, FunctionOccurrence[]>();
        index.set(pkg, byName);
      }
      const bucket = byName.get(occ.simpleName);
      if (bucket) bucket.push(occ);
      else byName.set(occ.simpleName, [occ]);
    }
  }
  return index;
}
