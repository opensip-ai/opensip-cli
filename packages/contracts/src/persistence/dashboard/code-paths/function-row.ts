/**
 * Reusable simple-table renderer for the Hot/Big/Wide/Untested views.
 *
 * Pulled out per §11.2: 4 callers justify the rule-of-three extraction.
 * Each caller passes its own `columns` array; the helper handles header,
 * body, the `data-body-hash` row attribute, and click delegation.
 *
 * Phase P4 first uses this helper; Phase P5 and P7 add the additional
 * callers (Big/Wide/Untested).
 */

export function dashboardFunctionRowJs(): string {
  return String.raw`
function renderFunctionRows(container, occurrences, columns) {
  while (container.firstChild) container.removeChild(container.firstChild);
  if (!occurrences || occurrences.length === 0) {
    container.appendChild(el('div', { class: 'empty', text: 'No functions to show.' }));
    return;
  }
  const table = el('table', { class: 'data-table sortable' });
  const thead = el('thead');
  const headRow = el('tr');
  for (const col of columns) headRow.appendChild(el('th', { text: col.label }));
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const occ of occurrences) {
    const tr = el('tr', { class: 'clickable', 'data-body-hash': occ.bodyHash });
    for (const col of columns) {
      const v = col.value(occ);
      tr.appendChild(el('td', { text: v == null ? '' : String(v) }));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  container.appendChild(table);
}
`;
}
