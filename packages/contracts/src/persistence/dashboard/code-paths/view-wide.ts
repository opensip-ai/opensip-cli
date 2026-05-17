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
  help: {
    title: 'Wide functions',
    sections: [
      { heading: 'What this is', body: 'Functions ranked by parameter count. The Signature column is a thumbnail of the parameter list (rest and optional markers preserved).' },
      { heading: 'Why you care', body: 'High parameter counts are a coupling smell — every parameter is a piece of context the caller has to assemble. They make functions hard to invoke, hard to mock, and hard to reuse.' },
      { heading: 'How to read it', body: 'Sort by Params descending (default). Anything above 5–6 parameters is worth scrutinizing. Watch for "boolean flag" parameters — those usually indicate a function doing two jobs that should be split.' },
      { heading: 'What to do', body: 'For top offenders, the usual moves are: introduce a parameter object (group related args into one type), split the function (if a flag controls divergent behavior), or invert the dependency (pass a smaller interface, not the kitchen sink).' },
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
