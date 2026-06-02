/**
 * View 1 — "Hot functions" (widest blast radius).
 *
 * Functions ranked by their composite blast score (`direct + 0.5 ×
 * transitive`, bounded reverse BFS over `indexes.callers`) desc and
 * filtered by `filterState`, rendered through `renderFunctionRows`
 * which paginates at 10 rows/page (no slice cap — pagination shows
 * everything). The raw inbound Callers count stays available as a
 * column. Blast is computed lazily by the browser mirror's `buildIndexes`
 * (`indexes.blastRadius` getter) on first read — i.e. on this panel's init.
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
        { heading: 'What this is', body: 'Functions ranked by blast radius — the composite reach score (direct + 0.5 × transitive callers, bounded reverse BFS) that estimates how much of the codebase a change here can ripple through. The Callers column is the raw count of inbound static call sites the graph tool resolved.' },
        { heading: 'Why you care', body: 'High-blast functions are leverage points. A bug here propagates everywhere. A perf regression here shows up across the product. Anything you change here ripples.' },
        { heading: 'How to read it', body: 'Sort by Blast descending (default). The top rows are your blast-radius candidates; Callers shows the direct in-degree behind that reach. The Package column shows which workspace owns each one — concentration in one package is fine; cross-package hotspots warrant scrutiny.' },
        { heading: 'What to do', body: 'For the top 5–10: confirm test coverage, watch them on PR reviews, and resist adding incidental responsibilities. If a high-blast function is also wide (many parameters) or big (many lines), that combination is a refactor signal.' },
      ],
    },
    metric: '(function(){ const b = indexes.blastRadius && indexes.blastRadius.get(occ.bodyHash); const callers = (indexes.callers.get(occ.bodyHash) || []).length; if (callers === 0) return false; return b ? b.score : callers; })()',
    rowExtras: '(function(){ return { __callers: (indexes.callers.get(occ.bodyHash) || []).length }; })()',
    columns: [
      { label: 'Function', value: 'o => displayName(o.simpleName)' },
      { label: 'Blast', value: 'o => o.__metric' },
      { label: 'Callers', value: 'o => o.__callers' },
      { label: 'Package', value: 'o => pkgOf(o)' },
      { label: 'File', value: 'o => o.filePath + \':\' + o.line' },
    ],
    headingText: 'Hot functions',
    emptyMessage: 'No called functions match the active filters.',
  });
}
