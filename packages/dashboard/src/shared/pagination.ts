/**
 * Pagination helpers — `paginateTable`, `paginateGroupedRows`, and the
 * page-button renderer.
 *
 * Every data-table in the dashboard paginates at 10 rows/page (or
 * 10 groups/page when expander rows are present). The grouped variant
 * keeps a data row and its trailing `.expander-row` together so they
 * page as one unit.
 *
 * `renderPageButtons` is shared between both paginators; the checks
 * catalog declares its own paginator inline that also calls this
 * helper, so it must be in scope before any caller.
 */
export function dashboardPaginationJs(): string {
  return String.raw`
// =======================================================
// PAGINATION HELPERS
// =======================================================

function renderPageButtons(container, currentPage, totalPages, goToPage) {
  container.appendChild(el('button', {class:'pagination-btn' + (currentPage === 0 ? ' disabled' : ''), text:'← Prev', onclick: () => { if (currentPage > 0) goToPage(currentPage - 1); }}));

  const pages = [];
  for (let p = 0; p < totalPages; p++) {
    if (p < 2 || p >= totalPages - 2 || Math.abs(p - currentPage) <= 1) {
      pages.push(p);
    } else if (pages.length > 0 && pages[pages.length - 1] !== -1) {
      pages.push(-1);
    }
  }

  pages.forEach(p => {
    if (p === -1) {
      container.appendChild(el('span', {style:'color:var(--text-dim);padding:4px 4px;font-size:12px', text:'…'}));
    } else {
      container.appendChild(el('button', {class:'pagination-btn' + (p === currentPage ? ' active' : ''), text: ''+(p+1), onclick: () => goToPage(p)}));
    }
  });

  container.appendChild(el('button', {class:'pagination-btn' + (currentPage >= totalPages-1 ? ' disabled' : ''), text:'Next →', onclick: () => { if (currentPage < totalPages-1) goToPage(currentPage + 1); }}));
}

function paginateTable(tbody, paginationContainer, pageSize) {
  const rows = Array.from(tbody.children);
  let currentPage = 0;
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));

  function renderPage() {
    const start = currentPage * pageSize;
    const end = start + pageSize;
    rows.forEach((row, i) => { row.style.display = (i >= start && i < end) ? '' : 'none'; });

    while (paginationContainer.firstChild) paginationContainer.removeChild(paginationContainer.firstChild);
    if (rows.length <= pageSize) return;

    const info = el('div', {class:'pagination-info', text: 'Showing ' + (start+1) + '-' + Math.min(end, rows.length) + ' of ' + rows.length});
    paginationContainer.appendChild(info);

    const btns = el('div', {class:'pagination-btns'});
    renderPageButtons(btns, currentPage, totalPages, (p) => { currentPage = p; renderPage(); });
    paginationContainer.appendChild(btns);
  }

  renderPage();
}

function paginateGroupedRows(tbody, paginationContainer, pageSize) {
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

  let currentPage = 0;
  const totalPages = Math.max(1, Math.ceil(groups.length / pageSize));

  function renderPage() {
    const start = currentPage * pageSize;
    const end = start + pageSize;
    groups.forEach((group, i) => {
      const visible = i >= start && i < end;
      group.forEach(row => {
        if (row.classList.contains('expander-row')) {
          row.dataset.paged = visible ? 'yes' : 'no';
          if (!visible) row.style.display = 'none';
        } else {
          row.style.display = visible ? '' : 'none';
        }
      });
    });

    while (paginationContainer.firstChild) paginationContainer.removeChild(paginationContainer.firstChild);
    if (groups.length <= pageSize) return;

    const info = el('div', {class:'pagination-info', text: 'Showing ' + (start+1) + '-' + Math.min(end, groups.length) + ' of ' + groups.length + ' checks'});
    paginationContainer.appendChild(info);

    const btns = el('div', {class:'pagination-btns'});
    renderPageButtons(btns, currentPage, totalPages, (p) => { currentPage = p; renderPage(); });
    paginationContainer.appendChild(btns);
  }

  renderPage();
}
`;
}
