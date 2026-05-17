/**
 * View 3 — "Wide functions" (most parameters).
 *
 * Phase P0 stub; Phase P5 implements the top-20 table sorted by
 * `params.length` descending with parameter-list thumbnails.
 */

export function dashboardViewWideJs(): string {
  return String.raw`
views.push({
  id: 'wide',
  label: 'Wide functions',
  render(container, catalog, indexes, filterState) {
    while (container.firstChild) container.removeChild(container.firstChild);
    container.appendChild(el('div', { class: 'empty', text: 'Coming in Phase P5 — Wide functions view.' }));
  },
});
`;
}
