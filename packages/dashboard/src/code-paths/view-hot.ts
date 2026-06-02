/**
 * View 1 — "Hot functions" (most callers).
 *
 * Functions sorted by `indexes.callers[bodyHash].length` desc and
 * filtered by `filterState`, rendered through `renderFunctionRows`
 * which paginates at 10 rows/page (no slice cap — pagination shows
 * everything).
 *
 * Implemented via `defineRankedView` — the rank-and-render skeleton
 * lives in `view-template.ts`; this file is the declarative config.
 */

import { defineRankedView } from './view-template.js';

export function dashboardViewHotJs(): string {
  return defineRankedView({
    id: 'hot',
    label: 'Hot functions',
    help: {
      title: 'Hot functions',
      sections: [
        { heading: 'What this is', body: 'Functions ranked by how many other in-project functions call them. The Callers column is the count of inbound static call sites the graph tool resolved.' },
        { heading: 'Why you care', body: 'Hot functions are leverage points. A bug here propagates everywhere. A perf regression here shows up across the product. Anything you change here ripples.' },
        { heading: 'How to read it', body: 'Sort by Callers descending (default). The top rows are your blast-radius candidates. The Package column shows which workspace owns each one — concentration in one package is fine; cross-package hotspots warrant scrutiny.' },
        { heading: 'What to do', body: 'For the top 5–10: confirm test coverage, watch them on PR reviews, and resist adding incidental responsibilities. If a hot function is also wide (many parameters) or big (many lines), that combination is a refactor signal.' },
      ],
    },
    metric: '(function(){ const n = (indexes.callers.get(occ.bodyHash) || []).length; return n === 0 ? false : n; })()',
    columns: [
      { label: 'Function', value: 'o => displayName(o.simpleName)' },
      { label: 'Callers', value: 'o => o.__metric' },
      { label: 'Package', value: 'o => pkgOf(o)' },
      { label: 'File', value: 'o => o.filePath + \':\' + o.line' },
    ],
    headingText: 'Hot functions',
    emptyMessage: 'No called functions match the active filters.',
  });
}
