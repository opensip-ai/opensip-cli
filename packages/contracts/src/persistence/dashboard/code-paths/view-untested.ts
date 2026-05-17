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
  help: {
    title: 'Untested production code',
    sections: [
      { heading: 'What this is', body: 'Production functions (defined outside test files) with zero static callers from any test file. Prod callers shows how many production functions still depend on each one — high values indicate broadly-used, untested code.' },
      { heading: 'Why you care', body: 'These are functions that ship without any compile-time tether to a test. They might still be exercised by integration tests at runtime, but the compiler gives you no signal if you break their contract.' },
      { heading: 'How to read it', body: 'Sort by Prod callers descending (default). The top rows are the highest-leverage gaps: code with broad reach and no test coverage. The Kind column tells you the function shape (utility, method, exported); the Package shows ownership.' },
      { heading: 'What to do', body: 'This list is not a quality gate — it is a prompt. For the top entries, ask: is this exercised through some other path I trust? If yes, write that down. If no, it is a coverage gap worth filling. False positives are normal: dynamic imports and reflection-based callers are invisible to static analysis.' },
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
        { label: 'Function', value: o => displayName(o.simpleName) },
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
