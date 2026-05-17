/**
 * View 7 — "Function search" (fuzzy match by simple/qualified name).
 *
 * Phase P0 stub; Phase P8 binds the persistent search input and renders
 * results inside the search tab.
 */

export function dashboardViewSearchJs(): string {
  return String.raw`
views.push({
  id: 'search',
  label: 'Search',
  render(container, catalog, indexes, filterState) {
    while (container.firstChild) container.removeChild(container.firstChild);
    container.appendChild(el('div', { class: 'empty', text: 'Coming in Phase P8 — Type into the search input to find functions.' }));
  },
});
`;
}
