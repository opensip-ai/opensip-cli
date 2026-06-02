// DEPRECATED — scheduled for removal with Plan D (graph-structural-rules).
// Single-metric ranked tab folded into the ranked-distribution "Functions"
// affordance (view-distribution.ts) and the rule findings surface. Still
// concatenated only by the legacy branch of dashboardCodePathsJs (the Plan B
// default, RESTRUCTURED_EXPLORE_TABS = false). Deleted when Plan D flips that
// flag and drops the legacy branch. See docs/plans/ready/graph-rules-symmetry/phase-4.
/**
 * View 2 — "Big functions" (largest body length).
 *
 * Functions sorted by `endLine - line` descending. Filterable; the
 * full ranked set is handed to `renderFunctionRows` which paginates
 * at 10 rows/page.
 *
 * Implemented via `defineRankedView` — the rank-and-render skeleton
 * lives in `view-template.ts`.
 */

import { defineRankedView } from './view-template.js';

export function dashboardViewBigJs(): string {
  return defineRankedView({
    id: 'big',
    label: 'Big functions',
    help: {
      title: 'Big functions',
      sections: [
        { heading: 'What this is', body: 'Functions ranked by body length (endLine − startLine + 1). Pure structural metric — no semantic analysis, just lines.' },
        { heading: 'Why you care', body: 'Long functions are hard to test, hard to read, and tend to grow more concerns over time. They are the most reliable rough proxy for accidental complexity.' },
        { heading: 'How to read it', body: 'Sort by Lines descending (default). Above ~80 lines is worth questioning; above ~150 is almost always doing too much. The Kind column distinguishes class methods from free functions — methods often legitimately get bigger because they share state.' },
        { heading: 'What to do', body: 'Pick a top offender, open it (click the row), and look at the Callees in the Function Card. If the body splits cleanly along callee boundaries, that is your refactor seam. If it is mostly inline logic, extract the largest cohesive block first.' },
      ],
    },
    metric: 'Math.max(0, (occ.endLine || occ.line) - occ.line + 1)',
    columns: [
      { label: 'Function', value: 'o => displayName(o.simpleName)' },
      { label: 'Lines', value: 'o => o.__metric' },
      { label: 'Kind', value: 'o => o.kind' },
      { label: 'Package', value: 'o => pkgOf(o)' },
      { label: 'File', value: 'o => o.filePath + \':\' + o.line' },
    ],
    headingText: 'Big functions',
    emptyMessage: 'No functions match the active filters.',
  });
}
