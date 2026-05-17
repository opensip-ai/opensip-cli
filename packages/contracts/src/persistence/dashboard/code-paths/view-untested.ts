/**
 * View 5 — "Untested production code".
 *
 * Production functions (inTestFile === false) where ZERO of the
 * static callers come from a test file. Sorted by inbound caller
 * count desc — most-called untested functions are highest-risk gaps.
 *
 * Note: this measures static reachability, not runtime coverage.
 * Conservative — false positives possible; cheap and uses only
 * catalog data.
 */

export function dashboardViewUntestedJs(): string {
  return String.raw`
views.push({
  id: 'untested',
  label: 'Untested',
  render(container, catalog, indexes, filterState) {
    while (container.firstChild) container.removeChild(container.firstChild);
    if (!catalog || !catalog.functions) {
      container.appendChild(el('div', { class: 'empty', text: 'No catalog loaded.' }));
      return;
    }
    const ranked = [];
    for (const occ of indexes.byBodyHash.values()) {
      if (occ.inTestFile) continue;
      // Apply the filter chips' package/kind, but the production-only
      // toggle is implicit (untested view is production-only by nature).
      if (filterState.packages.size > 0 && !filterState.packages.has(packageOfPath(occ.filePath))) continue;
      if (filterState.kinds.size > 0 && !filterState.kinds.has(occ.kind)) continue;
      const callerHashes = indexes.callers.get(occ.bodyHash) || [];
      let testCallerSeen = false;
      for (const h of callerHashes) {
        const c = indexes.byBodyHash.get(h);
        if (c && c.inTestFile) { testCallerSeen = true; break; }
      }
      if (testCallerSeen) continue;
      ranked.push({ occ, callerCount: callerHashes.length });
    }
    ranked.sort((a, b) => b.callerCount - a.callerCount);
    if (ranked.length === 0) {
      container.appendChild(el('div', { class: 'empty', text: 'Every production function is reachable from a test file (according to static analysis).' }));
      return;
    }
    renderFunctionRows(
      container,
      ranked.map(r => Object.assign({}, r.occ, { __callers: r.callerCount })),
      [
        { label: 'Function', value: o => o.simpleName },
        { label: 'Prod callers', value: o => o.__callers },
        { label: 'Kind', value: o => o.kind },
        { label: 'Package', value: o => packageOfPath(o.filePath) },
        { label: 'File', value: o => o.filePath + ':' + o.line },
      ],
      'Untested production code',
    );
  },
});
`;
}
