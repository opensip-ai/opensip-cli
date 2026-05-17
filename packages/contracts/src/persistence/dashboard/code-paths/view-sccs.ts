/**
 * View 6 — "Strongly-connected components" (call-graph cycles).
 *
 * Phase P0 stub; Phase P7 calls Tarjan via `findSccs(indexes)` and
 * renders the top-10 components of size ≥ 2.
 */

export function dashboardViewSccsJs(): string {
  return String.raw`
views.push({
  id: 'sccs',
  label: 'Cycles / SCCs',
  render(container, catalog, indexes, filterState) {
    while (container.firstChild) container.removeChild(container.firstChild);
    container.appendChild(el('div', { class: 'empty', text: 'Coming in Phase P7 — Strongly-connected components.' }));
  },
});
`;
}
