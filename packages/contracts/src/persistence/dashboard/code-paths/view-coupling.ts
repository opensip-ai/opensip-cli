/**
 * View 4 — "Package coupling heat map".
 *
 * Phase P0 stub; Phase P6 implements the per-package N×N matrix with
 * text-shaded density cells and click-to-call-site drilldown.
 */

export function dashboardViewCouplingJs(): string {
  return String.raw`
views.push({
  id: 'coupling',
  label: 'Coupling',
  render(container, catalog, indexes, filterState) {
    while (container.firstChild) container.removeChild(container.firstChild);
    container.appendChild(el('div', { class: 'empty', text: 'Coming in Phase P6 — Package coupling heat map.' }));
  },
});
`;
}
