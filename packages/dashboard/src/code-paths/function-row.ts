/**
 * Reusable simple-table renderer for the Hot/Big/Wide/Untested/Search
 * views.
 *
 * Wraps the rendered table in the same .section + .card shell used by
 * fit/sim's renderSessionTable so all dashboard tables share one shape:
 * a section heading, a card-bordered sortable table, and a pagination
 * footer wired through paginateTable (defined in shared.ts).
 *
 * Each caller passes its own `columns` array, a `heading` string, and
 * an optional `viewId` (used to attach the help-drawer info icon to
 * the heading). The helper handles header, body, click delegation
 * via data-body-hash, sortable activation, and pagination at 10
 * rows/page.
 */

export function dashboardFunctionRowJs(): string {
  return String.raw`
function makeSectionHeading(text, viewId) {
  // Heading + optional ⓘ button that opens the help drawer for this
  // view. SCCs and Coupling use the same shape inline.
  const h3 = el('h3');
  h3.appendChild(document.createTextNode(text));
  if (viewId && typeof openHelpDrawer === 'function') {
    const info = el('button', {
      class: 'section-info',
      'aria-label': 'About this view',
      title: 'About this view',
      text: 'i',
    });
    info.addEventListener('click', e => {
      e.stopPropagation();
      openHelpDrawer(viewId);
    });
    h3.appendChild(info);
  }
  return h3;
}

function renderFunctionRows(container, occurrences, columns, heading, viewId, skipHeading) {
  while (container.firstChild) container.removeChild(container.firstChild);
  if (!occurrences || occurrences.length === 0) {
    container.appendChild(el('div', { class: 'empty', text: 'No functions to show.' }));
    return;
  }
  const headingText = (heading || 'Results') + ' (' + occurrences.length + ')';
  const section = el('div', { class: 'section' });
  // skipHeading lets a caller render the section heading itself (e.g. ABOVE its
  // own controls row) rather than at the top of the rows host.
  if (!skipHeading) section.appendChild(makeSectionHeading(headingText, viewId));
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
