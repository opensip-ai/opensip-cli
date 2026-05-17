/**
 * View 6 — "Strongly-connected components" (call-graph cycles).
 *
 * Runs Tarjan's SCC algorithm via `findSccs(indexes)`, filters
 * size ≥ 2, sorts by size descending, renders top 10.
 */

export function dashboardViewSccsJs(): string {
  return String.raw`
views.push({
  id: 'sccs',
  label: 'Cycles / SCCs',
  render(container, catalog, indexes, filterState) {
    while (container.firstChild) container.removeChild(container.firstChild);
    if (!catalog || !catalog.functions) {
      container.appendChild(el('div', { class: 'empty', text: 'No catalog loaded.' }));
      return;
    }
    const sccs = findSccs(indexes).filter(s => s.length >= 2);
    sccs.sort((a, b) => b.length - a.length);
    const top = sccs.slice(0, 10);
    if (top.length === 0) {
      container.appendChild(el('div', { class: 'empty', text: 'No call-graph cycles found. The static call graph is a DAG.' }));
      return;
    }
    const table = el('table', { class: 'data-table' });
    const thead = el('thead');
    const headRow = el('tr');
    for (const label of ['Size', 'Members (preview)', 'Packages']) headRow.appendChild(el('th', { text: label }));
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = el('tbody');
    for (const scc of top) {
      const members = scc.map(h => indexes.byBodyHash.get(h)).filter(Boolean);
      const previewNames = members.slice(0, 5).map(m => m.simpleName);
      const previewMore = members.length > 5 ? ', ...' + (members.length - 5) + ' more' : '';
      const previewText = previewNames.join(', ') + previewMore;
      const pkgs = Array.from(new Set(members.map(m => packageOfPath(m.filePath)))).sort();
      const tr = el('tr', { class: 'clickable', 'data-body-hash': members[0] ? members[0].bodyHash : '' });
      tr.appendChild(el('td', { text: String(scc.length) }));
      tr.appendChild(el('td', { text: previewText }));
      tr.appendChild(el('td', { text: pkgs.join(', ') }));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    container.appendChild(table);
  },
});
`;
}
