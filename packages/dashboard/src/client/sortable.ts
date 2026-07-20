/**
 * Sortable-table activation.
 *
 * `makeSortable(table)` wires click handlers to each `<th>` so columns
 * can be sorted asc/desc with a numeric/date/string fallback. Keeps
 * any trailing `.expander-row` siblings glued to their parent during sort.
 *
 * After all rendering, a `setTimeout(0)` pass scans the DOM for
 * `.data-table.sortable` elements and activates each — this catches
 * tables created during the synchronous render but defers the
 * activation until after `renderXxxTab()` calls have returned.
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 */

import { collectGroupedTableRows, paginateGroupedRows, paginateTable } from './pagination.js';

/** Mutable per-table sort state, threaded through the column click handler. */
interface SortState {
  col: number;
  asc: boolean;
}

/**
 * Tables with their own filtered paginator can replace the default post-sort
 * pagination pass. The check catalog uses this to keep its active filters
 * authoritative after rows are reordered.
 */
const sortRefreshHandlers = new WeakMap<HTMLElement, () => void>();

export function registerSortRefreshHandler(table: HTMLElement, refresh: () => void): void {
  sortRefreshHandlers.set(table, refresh);
}

/** Compare two row groups by the text of column `colIdx` (numeric → date → string). */
function compareGroups(a: HTMLElement[], b: HTMLElement[], colIdx: number, asc: boolean): number {
  const aCell = a[0].children[colIdx] as HTMLElement | undefined;
  const bCell = b[0].children[colIdx] as HTMLElement | undefined;
  const aText = (aCell?.dataset.sortValue ?? aCell?.textContent ?? '').trim();
  const bText = (bCell?.dataset.sortValue ?? bCell?.textContent ?? '').trim();
  // Try numeric comparison
  const aNum = Number.parseFloat(aText);
  const bNum = Number.parseFloat(bText);
  if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
    return asc ? aNum - bNum : bNum - aNum;
  }
  // Date detection (contains / or -)
  const aDate = Date.parse(aText);
  const bDate = Date.parse(bText);
  if (!Number.isNaN(aDate) && !Number.isNaN(bDate)) {
    return asc ? aDate - bDate : bDate - aDate;
  }
  // String comparison
  return asc ? aText.localeCompare(bText) : bText.localeCompare(aText);
}

/** Re-append `groups` (data row + optional expander) into `tbody` in order. */
function reorderRows(tbody: Element, groups: HTMLElement[][]): void {
  for (const group of groups) {
    for (const row of group) tbody.append(row);
  }
}

/** Re-run pagination after a sort if a `.pagination` container follows the table. */
function repaginate(table: HTMLElement, tbody: HTMLElement, groups: HTMLElement[][]): void {
  const refresh = sortRefreshHandlers.get(table);
  if (refresh) {
    refresh();
    return;
  }
  const pagContainer = table.parentElement?.querySelector('.pagination');
  if (!(pagContainer instanceof HTMLElement)) return;
  const hasExpanders = groups.some((g) => g.length > 1);
  if (hasExpanders) {
    paginateGroupedRows(tbody, pagContainer, 10);
  } else {
    paginateTable(tbody, pagContainer, 10);
  }
}

/** Arguments for {@link sortByColumn}: the table parts + the clicked column + sort state. */
interface SortByColumnOptions {
  table: HTMLElement;
  tbody: HTMLElement;
  headers: HTMLElement[];
  /** The clicked `<th>` (receives the asc/desc indicator). */
  th: HTMLElement;
  /** Zero-based index of the clicked column. */
  colIdx: number;
  /** Mutable sort state, toggled in place. */
  state: SortState;
}

/** Sort the table body by `colIdx`, toggling direction when the same column repeats. */
function sortByColumn(options: SortByColumnOptions): void {
  const { table, tbody, headers, th, colIdx, state } = options;
  if (state.col === colIdx) {
    state.asc = !state.asc;
  } else {
    state.col = colIdx;
    state.asc = true;
  }

  // Update sort indicators
  for (const h of headers) h.dataset.sort = '';
  th.dataset.sort = state.asc ? 'asc' : 'desc';

  // Overview's synthetic suite-divider rows (single-cell `.suite-group-header`)
  // carry no sortable column data, so a column sort makes their grouping
  // meaningless — the per-row Suite column already records membership. Drop them
  // before collecting groups so they neither sort as '' (clustering every banner
  // at one end) nor detach from their sessions. Guarded by the class: a no-op on
  // every other tab's tables, and it never touches `.expander-row` grouping.
  for (const banner of tbody.querySelectorAll('.suite-group-header')) banner.remove();

  const groups = collectGroupedTableRows(tbody);
  groups.sort((a, b) => compareGroups(a, b, colIdx, state.asc));
  reorderRows(tbody, groups);
  repaginate(table, tbody, groups);
}

export function makeSortable(table: HTMLElement): void {
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  if (!thead || !tbody) return;

  const headers = [...thead.querySelectorAll('th')];
  const state: SortState = { col: -1, asc: true };

  headers.forEach((th, colIdx) => {
    if (!th.textContent?.trim()) return; // skip empty headers (arrow column)
    th.style.cursor = 'pointer';
    th.style.userSelect = 'none';
    th.addEventListener('click', () => {
      sortByColumn({ table, tbody, headers, th, colIdx, state });
    });
  });
}

// After all rendering: init sorting
setTimeout(() => {
  document.querySelectorAll('.data-table.sortable').forEach((t) => makeSortable(t as HTMLElement));
}, 0);
