/**
 * Reusable simple-table renderer for the Functions / ranked views.
 *
 * Wraps the rendered table in the same .section + .card shell used by
 * fit/sim's renderSessionTable so all dashboard tables share one shape:
 * a section heading, a card-bordered sortable table, and a pagination
 * footer wired through paginateTable.
 *
 * Each caller passes its own `columns` array, a `heading` string, and
 * an optional `viewId` (used to attach the help-drawer info icon to
 * the heading). The helper handles header, body, click delegation
 * via data-body-hash, sortable activation, and pagination at 10
 * rows/page.
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 */

import { el } from './el.js';
import { openHelpDrawer } from './help-drawer.js';
import { paginateTable } from './pagination.js';
import { makeSortable } from './sortable.js';

import type { OccLike } from './code-paths-types.js';

/** A column descriptor: a header label and a per-row value accessor. */
export interface RowColumn {
  label: string;
  // Cells render scalar values; `null`/`undefined` render as the empty string.
  value: (occ: OccLike) => string | number | null | undefined;
}

export function makeSectionHeading(text: string, viewId?: string): HTMLElement {
  // Heading + optional ⓘ button that opens the help drawer for this
  // view. Coupling uses the same shape inline.
  const h3 = el('h3');
  h3.append(text);
  if (viewId) {
    const info = el('button', {
      class: 'section-info',
      'aria-label': 'About this view',
      title: 'About this view',
      text: 'i',
    });
    info.addEventListener('click', (e) => {
      e.stopPropagation();
      openHelpDrawer(viewId);
    });
    h3.append(info);
  }
  return h3;
}

export function renderFunctionRows(
  container: HTMLElement,
  occurrences: readonly OccLike[] | null | undefined,
  columns: readonly RowColumn[],
  heading?: string,
  viewId?: string,
  skipHeading?: boolean,
): void {
  while (container.firstChild) container.firstChild.remove();
  if (!occurrences || occurrences.length === 0) {
    container.append(el('div', { class: 'empty', text: 'No functions to show.' }));
    return;
  }
  // Preserve the original `||` fallback: an empty-string heading also falls back
  // to 'Results' (not just null/undefined), so `??` would change behaviour.
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- empty-string heading must also fall back (byte-identical to the legacy emitter).
  const headingText = (heading || 'Results') + ' (' + occurrences.length + ')';
  const section = el('div', { class: 'section' });
  // skipHeading lets a caller render the section heading itself (e.g. ABOVE its
  // own controls row) rather than at the top of the rows host.
  if (!skipHeading) section.append(makeSectionHeading(headingText, viewId));
  const card = el('div', { class: 'card' });
  const table = el('table', { class: 'data-table sortable' });
  const thead = el('thead');
  const headRow = el('tr');
  for (const col of columns) headRow.append(el('th', { text: col.label }));
  thead.append(headRow);
  table.append(thead);
  const tbody = el('tbody');
  for (const occ of occurrences) {
    const tr = el('tr', { class: 'clickable', 'data-body-hash': occ.bodyHash });
    for (const col of columns) {
      const v = col.value(occ);
      tr.append(el('td', { text: v == null ? '' : String(v) }));
    }
    tbody.append(tr);
  }
  table.append(tbody);
  const pag = el('div', { class: 'pagination' });
  card.append(table);
  card.append(pag);
  section.append(card);
  container.append(section);
  paginateTable(tbody, pag, 10);
  makeSortable(table);
}
