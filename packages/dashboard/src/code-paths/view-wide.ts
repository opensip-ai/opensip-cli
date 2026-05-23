/**
 * View 3 — "Wide functions" (most parameters).
 *
 * Functions sorted by `params.length` descending, with a thumbnail
 * of the parameter list inline. Paginates via `renderFunctionRows`.
 *
 * Implemented via `defineRankedView` — the rank-and-render skeleton
 * lives in `view-template.ts`. The parameter-thumbnail helper is
 * declared in the view's `preamble` so it stays scoped to this view.
 */

import { defineRankedView } from './view-template.js';

export function dashboardViewWideJs(): string {
  return defineRankedView({
    id: 'wide',
    label: 'Wide functions',
    help: {
      title: 'Wide functions',
      sections: [
        { heading: 'What this is', body: 'Functions ranked by parameter count. The Signature column is a thumbnail of the parameter list (rest and optional markers preserved).' },
        { heading: 'Why you care', body: 'High parameter counts are a coupling smell — every parameter is a piece of context the caller has to assemble. They make functions hard to invoke, hard to mock, and hard to reuse.' },
        { heading: 'How to read it', body: 'Sort by Params descending (default). Anything above 5–6 parameters is worth scrutinizing. Watch for "boolean flag" parameters — those usually indicate a function doing two jobs that should be split.' },
        { heading: 'What to do', body: 'For top offenders, the usual moves are: introduce a parameter object (group related args into one type), split the function (if a flag controls divergent behavior), or invert the dependency (pass a smaller interface, not the kitchen sink).' },
      ],
    },
    preamble: `function paramThumb(occ) {
      const names = (occ.params || []).map(p => (p.rest ? '...' : '') + p.name + (p.optional ? '?' : ''));
      const shown = names.slice(0, 5).join(', ');
      const more = names.length > 5 ? ', ...' + (names.length - 5) + ' more' : '';
      return '(' + shown + more + ')';
    }`,
    metric: '(function(){ const n = (occ.params || []).length; return n === 0 ? false : n; })()',
    rowExtras: '{ __thumb: paramThumb(occ) }',
    columns: [
      { label: 'Function', value: 'o => displayName(o.simpleName)' },
      { label: 'Params', value: 'o => o.__metric' },
      { label: 'Signature', value: 'o => o.__thumb' },
      { label: 'Package', value: 'o => packageOfPath(o.filePath)' },
      { label: 'File', value: 'o => o.filePath + \':\' + o.line' },
    ],
    headingText: 'Wide functions',
    emptyMessage: 'No parameterized functions match the active filters.',
  });
}
