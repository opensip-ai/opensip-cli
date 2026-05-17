/**
 * Reusable simple-table renderer for the Hot/Big/Wide/Untested/Search
 * views.
 *
 * Wraps the rendered table in the same .section + .card shell used by
 * fit/sim's renderSessionTable so all dashboard tables share one shape:
 * a section heading, a card-bordered sortable table, and a pagination
 * footer wired through paginateTable (defined in shared.ts).
 *
 * Each caller passes its own `columns` array and a `heading` string;
 * the helper handles header, body, click delegation via data-body-hash,
 * sortable activation, and pagination at 10 rows/page.
 */

export function dashboardFunctionRowJs(): string {
  return String.raw`
function renderFunctionRows(container, occurrences, columns, heading) {
  while (container.firstChild) container.removeChild(container.firstChild);
  if (!occurrences || occurrences.length === 0) {
    container.appendChild(el('div', { class: 'empty', text: 'No functions to show.' }));
    return;
  }
  const headingText = (heading || 'Results') + ' (' + occurrences.length + ')';
  const section = el('div', { class: 'section' });
  section.appendChild(el('h3', { text: headingText }));
  const card = el('div', { class: 'card' });
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
  const pag = el('div', { class: 'pagination' });
  card.appendChild(table);
  card.appendChild(pag);
  section.appendChild(card);
  container.appendChild(section);
  if (typeof paginateTable === 'function') paginateTable(tbody, pag, 10);
  if (typeof makeSortable === 'function') makeSortable(table);
}
`;
}
