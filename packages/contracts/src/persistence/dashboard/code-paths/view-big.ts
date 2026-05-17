/**
 * View 2 — "Big functions" (largest body length).
 *
 * Phase P0 stub; Phase P5 implements the top-30 table sorted by
 * `endLine - line` descending.
 */

export function dashboardViewBigJs(): string {
  return String.raw`
views.push({
  id: 'big',
  label: 'Big functions',
  render(container, catalog, indexes, filterState) {
    while (container.firstChild) container.removeChild(container.firstChild);
    container.appendChild(el('div', { class: 'empty', text: 'Coming in Phase P5 — Big functions view.' }));
  },
});
`;
}
