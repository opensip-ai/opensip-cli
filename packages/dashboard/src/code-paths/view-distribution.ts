/**
 * View — "Functions" (ranked-distribution affordance).
 *
 * Replaces the four single-metric ranked tabs (big / hot / wide / untested)
 * with ONE sortable, paginated, filter-aware function table whose columns are
 * the union those tabs covered: lines, callers (hot), params/width (wide), and
 * a test-reachable flag (untested). The default sort is by lines descending
 * (the most-requested triage axis); the shared `makeSortable` lets the reader
 * re-sort by any column, so the sub-threshold tail (e.g. a 140-line function
 * under a 150 gate) stays triageable once the single-metric tabs are gone.
 *
 * Built on `defineRankedView` (the same skeleton the removed tabs used), so it
 * reuses `renderFunctionRows` / `makeSortable` / `paginateTable` and the
 * row-click → Function Card delegation with no new plumbing.
 *
 * Part of the Plan B Code Paths restructure; concatenated only in the
 * restructured (flag = true) branch of `dashboardCodePathsJs`.
 */

import { defineRankedView } from './view-template.js';

export function dashboardViewDistributionJs(): string {
  return defineRankedView({
    id: 'distribution',
    label: 'Functions',
    help: {
      title: 'Functions (distribution)',
      sections: [
        { heading: 'What this is', body: 'Every function in the catalog in one sortable table. Columns cover the metrics the former single-metric tabs ranked individually: body length (lines), inbound callers, parameter count (width), and whether the function is reachable only from tests.' },
        { heading: 'Why you care', body: 'Findings surface the rules that actually fired; this table is the raw distribution behind them. It is where you triage the sub-threshold tail — a 140-line function under a 150-line gate, a 3-param function just under a width rule — that a pass/fail findings list cannot show.' },
        { heading: 'How to read it', body: 'Sort by any column (click the header). Lines descending is the default. Callers = 0 plus no test reachability is an orphan; Test-only = yes means production code reached only from tests. Use the filter chips above the tab bar to scope by package, kind, or test-file membership.' },
        { heading: 'What to do', body: 'Click a row to open the Function Card and inspect callers/callees. Long bodies split along callee boundaries; wide signatures often want an options object; test-only functions usually belong in a __tests__/ helper.' },
      ],
    },
    // Default ranking metric: body length (lines). Re-sortable to any column.
    metric: 'Math.max(0, (occ.endLine || occ.line) - occ.line + 1)',
    preamble: String.raw`
    function distCallerCount(o) { return (indexes.callers.get(o.bodyHash) || []).length; }
    function distParamCount(o) { return (o.params || []).length; }
    function distTestOnly(o) {
      if (o.inTestFile) return false;
      const callers = indexes.callers.get(o.bodyHash) || [];
      if (callers.length === 0) return false;
      return callers.every(function(h) {
        const c = indexes.byBodyHash.get(h);
        return c && c.inTestFile === true;
      });
    }`,
    columns: [
      { label: 'Function', value: 'o => displayName(o.simpleName)' },
      { label: 'Lines', value: 'o => o.__metric' },
      { label: 'Callers', value: 'o => distCallerCount(o)' },
      { label: 'Params', value: 'o => distParamCount(o)' },
      // The former 'Test-only' column moved to a "Test-only" filter toggle (below).
      { label: 'Kind', value: 'o => o.kind' },
      { label: 'Package', value: 'o => pkgOf(o)' },
      { label: 'File', value: "o => o.filePath + ':' + o.line" },
    ],
    headingText: 'Functions',
    emptyMessage: 'No functions match the active filters.',
    // Absorbs the former standalone Search subtab: a name filter above
    // the table, re-filtering rows in place by function simple-name.
    searchByName: true,
    // Kind (single-select) + Package (single-select) dropdowns in the same
    // controls row, before the search box: Kind · Package · search.
    filterByKindPackage: true,
    // A "Test-only" checkbox after the search box — when checked, narrows the
    // table to production functions reached only from tests (distTestOnly).
    filterToggle: { label: 'Test-only', predicate: 'distTestOnly(occ)' },
  });
}
