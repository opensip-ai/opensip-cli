/**
 * Filter primitives for the Code Paths panel.
 *
 * The interactive "Filters" chip drawer that used to sit between the Explore
 * subtab and the view tab bar was removed — the Visualization view owns its own
 * controls and the other views don't need a shared chip bar. What remains is
 * the small shared surface still consumed elsewhere:
 *
 *   - `filterState` — default, non-interactive filter (production-only, all
 *     packages, all kinds). The Functions table reads it via `passesFilter`;
 *     the Coupling drilldown passes it through. Nothing mutates it now.
 *   - `passesFilter(occ, filterState)` — the per-row predicate the Functions
 *     view (and the Coupling drilldown) applies.
 *   - `packagesInCatalog(catalog)` / `KIND_LIST` — the package list and kind
 *     vocabulary the Visualization controls drive their Package and Kind
 *     selectors from.
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 */

import { pkgOf } from './path-utils.js';

import type { CatalogLike, FilterStateLike, OccLike } from './code-paths-types.js';

export const filterState: FilterStateLike = {
  packages: new Set<string>(),
  kinds: new Set<string>(),
  includeTests: false,
};

export const KIND_LIST: readonly string[] = [
  'function-declaration',
  'function-expression',
  'method',
  'arrow',
  'constructor',
  'getter',
  'setter',
  'module-init',
];

export function packagesInCatalog(catalog: CatalogLike | null): string[] {
  const pkgs = new Set<string>();
  if (!catalog?.functions) return [];
  for (const name of Object.keys(catalog.functions)) {
    for (const occ of catalog.functions[name] || []) {
      pkgs.add(pkgOf(occ));
    }
  }
  return [...pkgs].sort();
}

export function passesFilter(occ: OccLike, fs: FilterStateLike): boolean {
  if (!fs.includeTests && occ.inTestFile) return false;
  if (fs.packages.size > 0 && !fs.packages.has(pkgOf(occ))) return false;
  if (fs.kinds.size > 0 && !fs.kinds.has(occ.kind ?? '')) return false;
  return true;
}
