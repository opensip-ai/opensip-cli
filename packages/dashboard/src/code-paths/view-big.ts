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
  help: {
    title: 'Big functions',
    sections: [
      { heading: 'What this is', body: 'Functions ranked by body length (endLine − startLine + 1). Pure structural metric — no semantic analysis, just lines.' },
      { heading: 'Why you care', body: 'Long functions are hard to test, hard to read, and tend to grow more concerns over time. They are the most reliable rough proxy for accidental complexity.' },
      { heading: 'How to read it', body: 'Sort by Lines descending (default). Above ~80 lines is worth questioning; above ~150 is almost always doing too much. The Kind column distinguishes class methods from free functions — methods often legitimately get bigger because they share state.' },
      { heading: 'What to do', body: 'Pick a top offender, open it (click the row), and look at the Callees in the Function Card. If the body splits cleanly along callee boundaries, that is your refactor seam. If it is mostly inline logic, extract the largest cohesive block first.' },
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
        { label: 'Function', value: o => displayName(o.simpleName) },
        { label: 'Lines', value: o => o.__size },
        { label: 'Kind', value: o => o.kind },
        { label: 'Package', value: o => packageOfPath(o.filePath) },
        { label: 'File', value: o => o.filePath + ':' + o.line },
      ],
      'Big functions',
      'big',
    );
  },
});
`;
}
