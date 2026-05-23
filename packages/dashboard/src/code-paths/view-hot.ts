/**
 * View 1 — "Hot functions" (most callers).
 *
 * Functions sorted by `indexes.callers[bodyHash].length` desc and
 * filtered by `filterState`, rendered through `renderFunctionRows`
 * which paginates at 10 rows/page (no slice cap — pagination shows
 * everything).
 */

export function dashboardViewHotJs(): string {
  return String.raw`
views.push({
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
  render(container, catalog, indexes, filterState) {
    while (container.firstChild) container.removeChild(container.firstChild);
    if (!catalog || !catalog.functions) {
      container.appendChild(el('div', { class: 'empty', text: 'No catalog loaded.' }));
      return;
    }
    const ranked = [];
    for (const occ of indexes.byBodyHash.values()) {
      if (!passesFilter(occ, filterState)) continue;
      const callerCount = (indexes.callers.get(occ.bodyHash) || []).length;
      if (callerCount === 0) continue;
      ranked.push({ occ, callerCount });
    }
    ranked.sort((a, b) => b.callerCount - a.callerCount);
    if (ranked.length === 0) {
      container.appendChild(el('div', { class: 'empty', text: 'No called functions match the active filters.' }));
      return;
    }
    renderFunctionRows(
      container,
      ranked.map(r => Object.assign({}, r.occ, { __callers: r.callerCount })),
      [
        { label: 'Function', value: o => displayName(o.simpleName) },
        { label: 'Callers', value: o => o.__callers },
        { label: 'Package', value: o => packageOfPath(o.filePath) },
        { label: 'File', value: o => o.filePath + ':' + o.line },
      ],
      'Hot functions',
      'hot',
    );
  },
});
`;
}
