/**
 * View 7 — "Function search" (fuzzy match by simpleName).
 *
 * Binds to the persistent search input at the top of the panel. Typing
 * updates `searchQuery` (module-scoped state) and re-renders the
 * search-tab body via the standard `view.render` path. Enter/typing
 * also auto-switches to the search tab.
 *
 * Click a result → openFunctionCard.
 */

export function dashboardViewSearchJs(): string {
  return String.raw`
let searchQuery = '';

views.push({
  id: 'search',
  label: 'Search',
  render(container, catalog, indexes, filterState) {
    while (container.firstChild) container.removeChild(container.firstChild);
    if (!catalog || !catalog.functions) {
      container.appendChild(el('div', { class: 'empty', text: 'No catalog loaded.' }));
      return;
    }
    if (!searchQuery || searchQuery.trim().length === 0) {
      container.appendChild(el('div', { class: 'empty', text: 'Type into the search box at the top of the panel to find functions.' }));
      return;
    }
    const allNames = Array.from(indexes.bySimpleName.keys());
    const matches = fuzzyMatch(searchQuery, allNames).slice(0, 50);
    if (matches.length === 0) {
      container.appendChild(el('div', { class: 'empty', text: 'No matches for "' + searchQuery + '".' }));
      return;
    }
    const occurrences = [];
    for (const m of matches) {
      const hashes = indexes.bySimpleName.get(m.name) || [];
      for (const h of hashes) {
        const occ = indexes.byBodyHash.get(h);
        if (occ && passesFilter(occ, filterState)) occurrences.push(occ);
        if (occurrences.length >= 50) break;
      }
      if (occurrences.length >= 50) break;
    }
    if (occurrences.length === 0) {
      container.appendChild(el('div', { class: 'empty', text: 'Matches exist but none pass the active filters.' }));
      return;
    }
    renderFunctionRows(
      container,
      occurrences,
      [
        { label: 'Function', value: o => o.simpleName },
        { label: 'Kind', value: o => o.kind },
        { label: 'Package', value: o => packageOfPath(o.filePath) },
        { label: 'File', value: o => o.filePath + ':' + o.line },
      ],
    );
  },
});

function attachSearchInputHandler() {
  const input = document.getElementById('code-paths-search-input');
  if (!input) return;
  input.addEventListener('input', e => {
    searchQuery = e.target.value || '';
    activateView('search');
  });
}
`;
}
