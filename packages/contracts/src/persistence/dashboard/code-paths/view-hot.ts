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
    );
  },
});
`;
}
