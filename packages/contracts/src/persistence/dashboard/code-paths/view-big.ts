/**
 * View 2 — "Big functions" (largest body length).
 *
 * Functions sorted by `endLine - line` descending. Filterable; the
 * full ranked set is handed to `renderFunctionRows` which paginates
 * at 10 rows/page.
 */

export function dashboardViewBigJs(): string {
  return String.raw`
views.push({
  id: 'big',
  label: 'Big functions',
  render(container, catalog, indexes, filterState) {
    while (container.firstChild) container.removeChild(container.firstChild);
    if (!catalog || !catalog.functions) {
      container.appendChild(el('div', { class: 'empty', text: 'No catalog loaded.' }));
      return;
    }
    const ranked = [];
    for (const occ of indexes.byBodyHash.values()) {
      if (!passesFilter(occ, filterState)) continue;
      const size = Math.max(0, (occ.endLine || occ.line) - occ.line + 1);
      ranked.push({ occ, size });
    }
    ranked.sort((a, b) => b.size - a.size);
    if (ranked.length === 0) {
      container.appendChild(el('div', { class: 'empty', text: 'No functions match the active filters.' }));
      return;
    }
    renderFunctionRows(
      container,
      ranked.map(r => Object.assign({}, r.occ, { __size: r.size })),
      [
        { label: 'Function', value: o => o.simpleName },
        { label: 'Lines', value: o => o.__size },
        { label: 'Kind', value: o => o.kind },
        { label: 'Package', value: o => packageOfPath(o.filePath) },
        { label: 'File', value: o => o.filePath + ':' + o.line },
      ],
      'Big functions',
    );
  },
});
`;
}
