/**
 * View 3 — "Wide functions" (most parameters).
 *
 * Functions sorted by `params.length` descending, with a thumbnail
 * of the parameter list inline. Paginates via `renderFunctionRows`.
 */

export function dashboardViewWideJs(): string {
  return String.raw`
views.push({
  id: 'wide',
  label: 'Wide functions',
  render(container, catalog, indexes, filterState) {
    while (container.firstChild) container.removeChild(container.firstChild);
    if (!catalog || !catalog.functions) {
      container.appendChild(el('div', { class: 'empty', text: 'No catalog loaded.' }));
      return;
    }
    const ranked = [];
    for (const occ of indexes.byBodyHash.values()) {
      if (!passesFilter(occ, filterState)) continue;
      const arity = (occ.params || []).length;
      if (arity === 0) continue;
      ranked.push({ occ, arity });
    }
    ranked.sort((a, b) => b.arity - a.arity);
    if (ranked.length === 0) {
      container.appendChild(el('div', { class: 'empty', text: 'No parameterized functions match the active filters.' }));
      return;
    }
    function paramThumb(occ) {
      const names = (occ.params || []).map(p => (p.rest ? '...' : '') + p.name + (p.optional ? '?' : ''));
      const shown = names.slice(0, 5).join(', ');
      const more = names.length > 5 ? ', ...' + (names.length - 5) + ' more' : '';
      return '(' + shown + more + ')';
    }
    renderFunctionRows(
      container,
      ranked.map(r => Object.assign({}, r.occ, { __arity: r.arity, __thumb: paramThumb(r.occ) })),
      [
        { label: 'Function', value: o => displayName(o.simpleName) },
        { label: 'Params', value: o => o.__arity },
        { label: 'Signature', value: o => o.__thumb },
        { label: 'Package', value: o => packageOfPath(o.filePath) },
        { label: 'File', value: o => o.filePath + ':' + o.line },
      ],
      'Wide functions',
    );
  },
});
`;
}
