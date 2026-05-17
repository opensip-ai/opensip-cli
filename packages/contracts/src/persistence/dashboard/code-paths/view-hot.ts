/**
 * View 1 — "Hot functions" (most callers).
 *
 * Top 50 functions sorted by `indexes.callers[bodyHash].length` desc,
 * filtered by `filterState`, rendered through `renderFunctionRows` so
 * the table shape stays consistent with Big/Wide/Untested (§11.2).
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
    const top = ranked.slice(0, 50);
    if (top.length === 0) {
      container.appendChild(el('div', { class: 'empty', text: 'No called functions match the active filters.' }));
      return;
    }
    renderFunctionRows(
      container,
      top.map(r => Object.assign({}, r.occ, { __callers: r.callerCount })),
      [
        { label: 'Function', value: o => o.simpleName },
        { label: 'Callers', value: o => o.__callers },
        { label: 'Package', value: o => packageOfPath(o.filePath) },
        { label: 'File', value: o => o.filePath + ':' + o.line },
      ],
    );
  },
});
`;
}
