/**
 * View 1 — "Hot functions" (most callers).
 *
 * Phase P0 stub registers the placeholder view; Phase P4 implements
 * the sorted top-50 table with package/kind/test filters and click-to-
 * card delegation.
 */

export function dashboardViewHotJs(): string {
  return String.raw`
views.push({
  id: 'hot',
  label: 'Hot functions',
  render(container, catalog, indexes, filterState) {
    while (container.firstChild) container.removeChild(container.firstChild);
    container.appendChild(el('div', { class: 'empty', text: 'Coming in Phase P4 — Hot functions view.' }));
  },
});
`;
}
