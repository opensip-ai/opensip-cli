/**
 * View 7 — "Function search" (fuzzy match by simpleName).
 *
 * The search input lives inside this view (not above the tab bar) so it
 * is visible only when the user is in search mode. Typing updates
 * `searchQuery` (module-scoped state) and re-renders the results list
 * in place. The input auto-focuses when the tab activates.
 *
 * Click a result → openFunctionCard.
 */

export function dashboardViewSearchJs(): string {
  return String.raw`
let searchQuery = '';

views.push({
  id: 'search',
  label: 'Search',
  help: {
    title: 'Function search',
    sections: [
      { heading: 'What this is', body: 'A fuzzy-match search across every function in the catalog. Matches the simple name (last identifier in the qualified path) — type any subsequence of characters and it finds candidates that contain them in order.' },
      { heading: 'Why you care', body: 'When you half-remember a function name, or want to find every function whose name contains "validate", this is faster than grep and gives you click-through to the Function Card with callers and callees in context.' },
      { heading: 'How to read it', body: 'Results sort by match score: prefix matches and contiguous-character runs score higher. Each row shows the kind, owning package, and source file:line. Click a row to open the Function Card.' },
      { heading: 'What to do', body: 'Use it as the entry point for any "where is X" question. Combined with the package and kind filter chips above, you can scope a search to "every getter in the contracts package whose name contains state". The results respect the active filters.' },
    ],
  },
  render(container, catalog, indexes, filterState) {
    while (container.firstChild) container.removeChild(container.firstChild);
    if (!catalog || !catalog.functions) {
      container.appendChild(el('div', { class: 'empty', text: 'No catalog loaded.' }));
      return;
    }
    const input = el('input', {
      type: 'search',
      class: 'search-input code-paths-search',
      id: 'code-paths-search-input',
      placeholder: 'Search functions by name…',
    });
    input.value = searchQuery;
    input.addEventListener('input', e => {
      searchQuery = e.target.value || '';
      renderResults();
    });
    container.appendChild(input);

    const results = el('div', { class: 'code-paths-search-results' });
    container.appendChild(results);

    function renderResults() {
      while (results.firstChild) results.removeChild(results.firstChild);
      if (!searchQuery || searchQuery.trim().length === 0) {
        results.appendChild(el('div', { class: 'empty', text: 'Type a function name above to find matches.' }));
        return;
      }
      const allNames = Array.from(indexes.bySimpleName.keys());
      const matches = fuzzyMatch(searchQuery, allNames);
      if (matches.length === 0) {
        results.appendChild(el('div', { class: 'empty', text: 'No matches for "' + searchQuery + '".' }));
        return;
      }
      const occurrences = [];
      for (const m of matches) {
        const hashes = indexes.bySimpleName.get(m.name) || [];
        for (const h of hashes) {
          const occ = indexes.byBodyHash.get(h);
          if (occ && passesFilter(occ, filterState)) occurrences.push(occ);
        }
      }
      if (occurrences.length === 0) {
        results.appendChild(el('div', { class: 'empty', text: 'Matches exist but none pass the active filters.' }));
        return;
      }
      renderFunctionRows(
        results,
        occurrences,
        [
          { label: 'Function', value: o => displayName(o.simpleName) },
          { label: 'Kind', value: o => o.kind },
          { label: 'Package', value: o => pkgOf(o) },
          { label: 'File', value: o => o.filePath + ':' + o.line },
        ],
        'Search results',
        'search',
      );
    }

    renderResults();
  },
  onActivate() {
    const input = document.getElementById('code-paths-search-input');
    if (input && typeof input.focus === 'function') input.focus();
  },
});
`;
}
