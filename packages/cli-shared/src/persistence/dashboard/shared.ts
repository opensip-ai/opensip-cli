/**
 * Shared dashboard JS — el() helper, pagination, tab switching.
 * Returns JS code as a string to be inlined in the <script> block.
 */

export function dashboardSharedJs(): string {
  return `
// Tab switching
document.getElementById('tab-bar').addEventListener('click', e => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  tab.classList.add('active');
  document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
});

function el(tag, attrs, children) {
  const e = document.createElement(tag);
  if (attrs) Object.entries(attrs).forEach(([k,v]) => {
    if (k === 'text') e.textContent = v;
    else if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  });
  if (children) children.forEach(c => { if (typeof c === 'string') e.appendChild(document.createTextNode(c)); else if (c) e.appendChild(c); });
  return e;
}

// =======================================================
// PAGINATION HELPERS
// =======================================================

function renderPageButtons(container, currentPage, totalPages, goToPage) {
  container.appendChild(el('button', {class:'pagination-btn' + (currentPage === 0 ? ' disabled' : ''), text:'\\u2190 Prev', onclick: () => { if (currentPage > 0) goToPage(currentPage - 1); }}));

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
      container.appendChild(el('span', {style:'color:var(--text-dim);padding:4px 4px;font-size:12px', text:'\\u2026'}));
    } else {
      container.appendChild(el('button', {class:'pagination-btn' + (p === currentPage ? ' active' : ''), text: ''+(p+1), onclick: () => goToPage(p)}));
    }
  });

  container.appendChild(el('button', {class:'pagination-btn' + (currentPage >= totalPages-1 ? ' disabled' : ''), text:'Next \\u2192', onclick: () => { if (currentPage < totalPages-1) goToPage(currentPage + 1); }}));
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
