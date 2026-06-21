/**
 * View — "Functions" (ranked-distribution affordance).
 *
 * Replaces the four single-metric ranked tabs (big / hot / wide / untested)
 * with ONE sortable, paginated, filter-aware function table whose columns are
 * the union those tabs covered: lines, callers (hot), params/width (wide), and
 * a test-reachable flag (untested, now a toggle). The default sort is by lines
 * descending; the shared `makeSortable` lets the reader re-sort by any column.
 *
 * Built on `defineRankedView` (the same skeleton the removed tabs used), so it
 * reuses `renderFunctionRows` / `makeSortable` / `paginateTable` and the
 * row-click → Function Card delegation with no new plumbing.
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`. Registering
 * the view is a load-time side effect (the `defineRankedView` call below).
 */

import { displayName, pkgOf } from './path-utils.js';
import { defineRankedView } from './view-template.js';

import type { IndexesLike, OccLike } from './code-paths-types.js';

// The Callers column accessor and the Test-only toggle predicate need the
// per-render `indexes`, but `renderFunctionRows` column accessors and the toggle
// predicate receive only the occurrence. The ranking `metric` callback DOES
// receive `indexes` and runs first for every row before any render, so it
// records the active indexes here for the accessors below to read. A single
// catalog is loaded per page, so this binding is stable across a render pass.
let currentIndexes: IndexesLike;

/** Body length in lines for an occurrence (the default ranking metric). */
function lineCount(occ: OccLike): number {
  return Math.max(0, (occ.endLine ?? occ.line ?? 0) - (occ.line ?? 0) + 1);
}

/** Inbound caller count for an occurrence. */
function distCallerCount(occ: OccLike, indexes: IndexesLike): number {
  return (indexes.callers.get(occ.bodyHash) ?? []).length;
}

/** Parameter (signature width) count for an occurrence. */
function distParamCount(occ: OccLike): number {
  return (occ.params ?? []).length;
}

/** True when a production function is reachable ONLY from test files. */
function distTestOnly(occ: OccLike, indexes: IndexesLike): boolean {
  if (occ.inTestFile) return false;
  const callers = indexes.callers.get(occ.bodyHash) ?? [];
  if (callers.length === 0) return false;
  return callers.every((h) => {
    const c = indexes.byBodyHash.get(h);
    return c?.inTestFile === true;
  });
}

defineRankedView({
  id: 'distribution',
  label: 'Functions',
  help: {
    title: 'Functions (distribution)',
    sections: [
      {
        heading: 'What this is',
        body: 'Every function in the catalog in one sortable table. Columns cover the metrics the former single-metric tabs ranked individually: body length (lines), inbound callers, parameter count (width), and whether the function is reachable only from tests.',
      },
      {
        heading: 'Why you care',
        body: 'Findings surface the rules that actually fired; this table is the raw distribution behind them. It is where you triage the sub-threshold tail — a 140-line function under a 150-line gate, a 3-param function just under a width rule — that a pass/fail findings list cannot show.',
      },
      {
        heading: 'How to read it',
        body: 'Sort by any column (click the header). Lines descending is the default. Callers = 0 plus no test reachability is an orphan; Test-only = yes means production code reached only from tests. Use the filter chips above the tab bar to scope by package, kind, or test-file membership.',
      },
      {
        heading: 'What to do',
        body: 'Click a row to open the Function Card and inspect callers/callees. Long bodies split along callee boundaries; wide signatures often want an options object; test-only functions usually belong in a __tests__/ helper.',
      },
    ],
  },
  // Default ranking metric: body length (lines). Re-sortable to any column.
  // Records the active `indexes` for the Callers column + Test-only toggle (see
  // the `currentIndexes` note above) — metric runs for every row before render.
  metric: (occ, indexes) => {
    currentIndexes = indexes;
    return lineCount(occ);
  },
  columns: [
    { label: 'Function', value: (o) => displayName(o.simpleName) },
    { label: 'Lines', value: (o) => lineCount(o) },
    // The indexes closure is captured per-render via the renderer; callers need
    // it, so these columns read it from the module-level binding set on render.
    { label: 'Callers', value: (o) => distCallerCount(o, currentIndexes) },
    { label: 'Params', value: (o) => distParamCount(o) },
    // The former 'Test-only' column moved to a "Test-only" filter toggle (below).
    { label: 'Kind', value: (o) => o.kind },
    { label: 'Package', value: (o) => pkgOf(o) },
    { label: 'File', value: (o) => o.filePath + ':' + o.line },
  ],
  headingText: 'Functions',
  emptyMessage: 'No functions match the active filters.',
  // Absorbs the former standalone Search subtab: a name filter above the table,
  // re-filtering rows in place by function simple-name.
  searchByName: true,
  // Kind (single-select) + Package (single-select) dropdowns in the same
  // controls row, before the search box: Kind · Package · search.
  filterByKindPackage: true,
  // A "Test-only" checkbox after the search box — when checked, narrows the
  // table to production functions reached only from tests (distTestOnly).
  filterToggle: { label: 'Test-only', predicate: (occ) => distTestOnly(occ, currentIndexes) },
});
