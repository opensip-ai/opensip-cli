/**
 * Sortable-table activation.
 *
 * `makeSortable(table)` wires click handlers to each `<th>` so columns
 * can be sorted asc/desc with a numeric/date/string fallback. Keeps
 * any trailing `.expander-row` glued to its parent during sort.
 *
 * After all rendering, a `setTimeout(0)` pass scans the DOM for
 * `.data-table.sortable` elements and activates each — this catches
 * tables created during the synchronous render but defers the
 * activation until after `renderXxxTab()` calls have returned.
 */
export function dashboardSortableJs(): string {
  return String.raw`
// =======================================================
// SORTABLE TABLE COLUMNS
// =======================================================

function makeSortable(table) {
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');
  if (!thead || !tbody) return;

  const headers = Array.from(thead.querySelectorAll('th'));
  let sortCol = -1;
  let sortAsc = true;

  headers.forEach((th, colIdx) => {
    if (!th.textContent.trim()) return; // skip empty headers (arrow column)
    th.style.cursor = 'pointer';
    th.style.userSelect = 'none';
    th.addEventListener('click', () => {
      if (sortCol === colIdx) {
        sortAsc = !sortAsc;
      } else {
        sortCol = colIdx;
        sortAsc = true;
      }

      // Update sort indicators
      headers.forEach(h => { h.dataset.sort = ''; });
      th.dataset.sort = sortAsc ? 'asc' : 'desc';

      // Collect data rows with their expander rows
      const allRows = Array.from(tbody.children);
      const groups = [];
      for (let i = 0; i < allRows.length; i++) {
        const row = allRows[i];
        if (row.classList.contains('expander-row')) continue;
        const group = [row];
        if (i + 1 < allRows.length && allRows[i+1].classList.contains('expander-row')) {
          group.push(allRows[i+1]);
        }
        groups.push(group);
      }

      groups.sort((a, b) => {
        const aText = (a[0].children[colIdx]?.textContent || '').trim();
        const bText = (b[0].children[colIdx]?.textContent || '').trim();
        // Try numeric comparison
        const aNum = parseFloat(aText);
        const bNum = parseFloat(bText);
        if (!isNaN(aNum) && !isNaN(bNum)) {
          return sortAsc ? aNum - bNum : bNum - aNum;
        }
        // Date detection (contains / or -)
        const aDate = Date.parse(aText);
        const bDate = Date.parse(bText);
        if (!isNaN(aDate) && !isNaN(bDate)) {
          return sortAsc ? aDate - bDate : bDate - aDate;
        }
        // String comparison
        return sortAsc ? aText.localeCompare(bText) : bText.localeCompare(aText);
      });

      // Reorder DOM — append each group (data row + optional expander)
      groups.forEach(group => {
        group.forEach(row => tbody.appendChild(row));
      });

      // Re-paginate if a pagination container exists after the table
      const pagContainer = table.parentElement?.querySelector('.pagination');
      if (pagContainer) {
        const hasExpanders = groups.some(g => g.length > 1);
        if (hasExpanders) {
          paginateGroupedRows(tbody, pagContainer, 10);
        } else {
          paginateTable(tbody, pagContainer, 10);
        }
      }
    });
  });
}

// After all rendering: init sorting
setTimeout(() => {
  document.querySelectorAll('.data-table.sortable').forEach(t => makeSortable(t));
}, 0);
`;
}
