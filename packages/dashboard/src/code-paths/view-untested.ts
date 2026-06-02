// DEPRECATED — scheduled for removal with Plan D (graph-structural-rules).
// Single-metric ranked tab folded into the ranked-distribution "Functions"
// affordance (view-distribution.ts) and the rule findings surface. Still
// concatenated only by the legacy branch of dashboardCodePathsJs (the Plan B
// default, RESTRUCTURED_EXPLORE_TABS = false). Deleted when Plan D flips that
// flag and drops the legacy branch. See docs/plans/ready/graph-rules-symmetry/phase-4.
/**
 * View 5 — "Untested production code".
 *
 * Production functions (inTestFile === false) where ZERO of the
 * static callers come from a test file. Sorted by inbound caller
 * count desc — most-called untested functions are highest-risk gaps.
 *
 * Note: this measures static reachability, not runtime coverage.
 * Conservative — false positives possible; cheap and uses only
 * catalog data.
 *
 * Implemented via `defineRankedView`. The predicate folds in the
 * production-only check, the package/kind chip filters (the
 * includeTests chip is meaningless here — untested is production-only
 * by definition), and the "no test caller" reachability check.
 */

import { defineRankedView } from './view-template.js';

export function dashboardViewUntestedJs(): string {
  return defineRankedView({
    id: 'untested',
    label: 'Untested',
    help: {
      title: 'Untested production code',
      sections: [
        { heading: 'What this is', body: 'Production functions (defined outside test files) with zero static callers from any test file. Prod callers shows how many production functions still depend on each one — high values indicate broadly-used, untested code.' },
        { heading: 'Why you care', body: 'These are functions that ship without any compile-time tether to a test. They might still be exercised by integration tests at runtime, but the compiler gives you no signal if you break their contract.' },
        { heading: 'How to read it', body: 'Sort by Prod callers descending (default). The top rows are the highest-leverage gaps: code with broad reach and no test coverage. The Kind column tells you the function shape (utility, method, exported); the Package shows ownership.' },
        { heading: 'What to do', body: 'This list is not a quality gate — it is a prompt. For the top entries, ask: is this exercised through some other path I trust? If yes, write that down. If no, it is a coverage gap worth filling. False positives are normal: dynamic imports and reflection-based callers are invisible to static analysis.' },
      ],
    },
    predicate: `(function(){
      if (occ.inTestFile) return false;
      if (filterState.packages.size > 0 && !filterState.packages.has(pkgOf(occ))) return false;
      if (filterState.kinds.size > 0 && !filterState.kinds.has(occ.kind)) return false;
      const callerHashes = indexes.callers.get(occ.bodyHash) || [];
      for (const h of callerHashes) {
        const c = indexes.byBodyHash.get(h);
        if (c && c.inTestFile) return false;
      }
      return true;
    })()`,
    metric: '(indexes.callers.get(occ.bodyHash) || []).length',
    columns: [
      { label: 'Function', value: 'o => displayName(o.simpleName)' },
      { label: 'Prod callers', value: 'o => o.__metric' },
      { label: 'Kind', value: 'o => o.kind' },
      { label: 'Package', value: 'o => pkgOf(o)' },
      { label: 'File', value: 'o => o.filePath + \':\' + o.line' },
    ],
    headingText: 'Untested production code',
    emptyMessage: 'Every production function is reachable from a test file (according to static analysis).',
  });
}
