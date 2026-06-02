// DEPRECATED — scheduled for removal with Plan D (graph-structural-rules).
// The standalone "Cycles / SCCs" tab is folded into the graph topology view
// as the "Highlight cycles" toggle (view-graph.ts); the server-side SCC code
// (graph-scc.ts / graph-view-model.ts) is RETAINED. Still concatenated only by
// the legacy branch of dashboardCodePathsJs (the Plan B default,
// RESTRUCTURED_EXPLORE_TABS = false). Deleted when Plan D flips that flag and
// drops the legacy branch. See docs/plans/ready/graph-rules-symmetry/phase-4.
/**
 * View 6 — "Strongly-connected components" (call-graph cycles).
 *
 * Reads the engine-emitted `catalog.features.scc` rows (Plan C — the
 * dashboard no longer runs its own Tarjan), filters size ≥ 2, sorts by
 * size descending, and renders the full set inside the standard .section
 * + .card shell with sortable headers and pagination at 10 rows/page.
 * When the catalog carries no `scc` feature (a non-dashboard run) the
 * view shows a no-data empty state.
 */

export function dashboardViewSccsJs(): string {
  return String.raw`
views.push({
  id: 'sccs',
  label: 'Cycles / SCCs',
  help: {
    title: 'Strongly-connected components (cycles)',
    sections: [
      { heading: 'What this is', body: 'Groups of functions that can all reach each other through call edges, found via Tarjan’s SCC algorithm. Size is the number of functions in the cycle; Members previews the first few; Packages shows which workspaces participate.' },
      { heading: 'Why you care', body: 'A non-trivial SCC means the functions are mutually recursive. That can be intentional (a parser, a tree walker) but more often it indicates accidental tangling — code that grew in two directions and met in the middle.' },
      { heading: 'How to read it', body: 'Sort by Size descending (default). Size 2 is usually fine (direct mutual recursion is a known pattern). Size 3+ that spans multiple packages is a layering smell — packages are not supposed to depend cyclically on each other.' },
      { heading: 'What to do', body: 'For unexpected cycles, click into a member to inspect its callers and callees. Breaking the cycle usually means extracting the shared protocol into a third place that both sides depend on, or inverting one of the calls (callback / event instead of direct invocation).' },
    ],
  },
  render(container, catalog, indexes, filterState) {
    while (container.firstChild) container.removeChild(container.firstChild);
    if (!catalog || !catalog.functions) {
      container.appendChild(el('div', { class: 'empty', text: 'No catalog loaded.' }));
      return;
    }
    // SCCs come from the engine 'scc' feature (Plan C); the dashboard no
    // longer runs its own Tarjan. Each row is { id, members, sccSize,
    // crossesPackages }; we keep cycles (sccSize >= 2). Absent features ⇒
    // no-data empty state (a default run does not materialize scc).
    const sccFeatures = (catalog.features && catalog.features.scc) || null;
    if (!sccFeatures) {
      container.appendChild(el('div', { class: 'empty', text: 'No cycle data in this catalog. Re-run the graph for a dashboard to compute strongly-connected components.' }));
      return;
    }
    const sccs = sccFeatures.filter(s => s.sccSize >= 2);
    sccs.sort((a, b) => b.sccSize - a.sccSize);
    if (sccs.length === 0) {
      container.appendChild(el('div', { class: 'empty', text: 'No call-graph cycles found. The static call graph is a DAG.' }));
      return;
    }
    const section = el('div', { class: 'section' });
    section.appendChild(makeSectionHeading('Cycles / SCCs (' + sccs.length + ')', 'sccs'));
    const card = el('div', { class: 'card' });
    const table = el('table', { class: 'data-table sortable' });
    const thead = el('thead');
    const headRow = el('tr');
    for (const label of ['Size', 'Members (preview)', 'Packages']) headRow.appendChild(el('th', { text: label }));
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = el('tbody');
    for (const scc of sccs) {
      const members = scc.members.map(h => indexes.byBodyHash.get(h)).filter(Boolean);
      const previewNames = members.slice(0, 5).map(m => displayName(m.simpleName));
      const previewMore = members.length > 5 ? ', ...' + (members.length - 5) + ' more' : '';
      const previewText = previewNames.join(', ') + previewMore;
      const pkgs = Array.from(new Set(members.map(m => pkgOf(m)))).sort();
      const tr = el('tr', { class: 'clickable', 'data-body-hash': members[0] ? members[0].bodyHash : '' });
      tr.appendChild(el('td', { text: String(scc.sccSize) }));
      tr.appendChild(el('td', { text: previewText }));
      tr.appendChild(el('td', { text: pkgs.join(', ') }));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    const pag = el('div', { class: 'pagination' });
    card.appendChild(table);
    card.appendChild(pag);
    section.appendChild(card);
    container.appendChild(section);
    if (typeof paginateTable === 'function') paginateTable(tbody, pag, 10);
    if (typeof makeSortable === 'function') makeSortable(table);
  },
});
`;
}
