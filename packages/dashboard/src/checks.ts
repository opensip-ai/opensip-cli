/**
 * Checks catalog rendering — browsable catalog of checks with run stats.
 * Reusable: renderChecksCatalog(container, catalogData) can be called from any panel.
 * Returns JS code as a string.
 */

export function dashboardChecksJs(): string {
  return `
// =======================================================
// CHECKS CATALOG
// =======================================================

function computeCheckStats() {
  const stats = {};
  for (const s of sessions) {
    for (const ch of s.checks) {
      if (!stats[ch.checkSlug]) stats[ch.checkSlug] = { runs: 0, passed: 0, failed: 0, lastRun: null };
      const st = stats[ch.checkSlug];
      st.runs++;
      if (ch.passed) st.passed++; else st.failed++;
      if (!st.lastRun || s.timestamp > st.lastRun) st.lastRun = s.timestamp;
    }
  }
  return stats;
}
const checkStats = computeCheckStats();

/** Render longDescription as DOM nodes with bold and code formatting. Safe — no innerHTML. */
function renderLongDesc(text) {
  const container = document.createElement('div');
  container.className = 'check-long-desc';
  if (!text) return container;
  const parts = text.split(/(\\*\\*[^*]+\\*\\*|\\\`[^\\\`]+\\\`|\\n)/g);
  parts.forEach(part => {
    if (part === '\\n') {
      container.appendChild(document.createElement('br'));
    } else if (part.startsWith('**') && part.endsWith('**')) {
      const strong = document.createElement('strong');
      strong.textContent = part.slice(2, -2);
      container.appendChild(strong);
    } else if (part.startsWith('\\\`') && part.endsWith('\\\`')) {
      const code = document.createElement('code');
      code.textContent = part.slice(1, -1);
      container.appendChild(code);
    } else {
      container.appendChild(document.createTextNode(part));
    }
  });
  return container;
}

/**
 * Render a check catalog table into any container element.
 * @param panel - DOM element to render into
 * @param catalogData - array of check catalog entries
 */
function renderChecksCatalog(panel, catalogData) {
  if (!catalogData.length) {
    panel.appendChild(el('div', {class:'empty', text:'No checks registered.'}));
    return;
  }

  const allTags = new Set();
  catalogData.forEach(c => (c.tags || []).forEach(t => allTags.add(t)));
  const sortedTags = Array.from(allTags).sort();

  // Filter bar
  const filterBar = el('div', {class:'filter-bar'});
  const searchInput = el('input', {class:'search-input', type:'text', placeholder:'Search checks...'});
  const tagSelect = el('select', {class:'filter-select'});
  tagSelect.appendChild(el('option', {value:'', text:'All tags'}));
  sortedTags.forEach(t => tagSelect.appendChild(el('option', {value:t, text:t})));
  const sourceSelect = el('select', {class:'filter-select'});
  ['', 'built-in', 'community'].forEach(v => {
    sourceSelect.appendChild(el('option', {value:v, text: v || 'All sources'}));
  });
  filterBar.appendChild(searchInput);
  filterBar.appendChild(tagSelect);
  filterBar.appendChild(sourceSelect);
  panel.appendChild(filterBar);

  // Stats summary
  const totalChecks = catalogData.length;
  const builtinCount = catalogData.filter(c => c.source === 'built-in').length;
  const communityCount = catalogData.filter(c => c.source === 'community').length;
  const statsRow = el('div', {style:'display:flex;gap:16px;margin-bottom:16px;font-size:13px;color:var(--text-muted)'});
  statsRow.appendChild(el('span', {text: totalChecks + ' total checks'}));
  statsRow.appendChild(el('span', {text: builtinCount + ' built-in', style:'color:var(--accent)'}));
  if (communityCount > 0) statsRow.appendChild(el('span', {text: communityCount + ' community', style:'color:var(--accent-sim)'}));
  panel.appendChild(statsRow);

  // Table
  const table = el('table', {class:'data-table sortable'});
  const thead = el('thead');
  const headerRow = el('tr');
  ['', 'Check', 'Tags', 'Confidence', 'Source', 'Runs', 'Pass Rate', 'Last Run'].forEach(h => {
    headerRow.appendChild(el('th', {text: h}));
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  const sorted = [...catalogData].sort((a, b) => a.slug.localeCompare(b.slug));
  const uid = 'cc-' + Math.random().toString(36).slice(2, 8);

  sorted.forEach((check, i) => {
    const st = checkStats[check.slug] || { runs: 0, passed: 0, failed: 0, lastRun: null };
    const rate = st.runs > 0 ? Math.round((st.passed / st.runs) * 100) : -1;
    const hasDesc = !!check.longDescription;
    const expanderId = uid + '-exp-' + i;

    const arrowCell = el('td', {style:'width:24px;text-align:center;color:var(--text-dim);font-size:12px'});
    if (hasDesc) arrowCell.textContent = '\\u25B6';

    const row = el('tr', {
      class: hasDesc ? 'clickable' : '',
      'data-slug': check.slug,
      'data-tags': (check.tags || []).join(','),
      'data-source': check.source,
      'data-name': check.name.toLowerCase(),
      onclick: hasDesc ? () => {
        const exp = document.getElementById(expanderId);
        if (exp) {
          const isOpen = exp.classList.toggle('open');
          exp.style.display = isOpen ? 'table-row' : 'none';
          arrowCell.textContent = isOpen ? '\\u25BC' : '\\u25B6';
        }
        row.classList.toggle('expanded');
      } : undefined
    });
    row.appendChild(arrowCell);

    const nameCell = el('td', {style:'font-weight:500'});
    nameCell.appendChild(document.createTextNode(check.slug));
    row.appendChild(nameCell);

    const tagsCell = el('td');
    (check.tags || []).slice(0, 4).forEach(t => {
      tagsCell.appendChild(el('span', {class:'tag-badge', text:t}));
    });
    if ((check.tags || []).length > 4) {
      tagsCell.appendChild(el('span', {class:'tag-badge', text:'+' + ((check.tags || []).length - 4)}));
    }
    row.appendChild(tagsCell);

    const confCell = el('td');
    confCell.appendChild(el('span', {class:'badge badge-' + check.confidence, text: check.confidence}));
    row.appendChild(confCell);

    const sourceCell = el('td');
    const sourceStyle = check.source === 'built-in' ? 'color:var(--accent)' : 'color:var(--accent-sim)';
    sourceCell.appendChild(el('span', {text: check.source, style: sourceStyle + ';font-size:12px'}));
    row.appendChild(sourceCell);

    row.appendChild(el('td', {text: st.runs > 0 ? '' + st.runs : '\\u2014', style:'color:var(--text-dim)'}));

    const rateCell = el('td');
    if (rate >= 0) {
      const rateColor = rate >= 90 ? 'var(--success)' : rate >= 70 ? 'var(--warning)' : 'var(--error)';
      const bar = el('span', {class:'pass-rate-bar'});
      const track = el('span', {class:'pass-rate-track'});
      track.appendChild(el('span', {class:'pass-rate-fill', style:'width:' + rate + '%;background:' + rateColor}));
      bar.appendChild(track);
      bar.appendChild(el('span', {text: rate + '%', style:'font-size:12px;color:' + rateColor}));
      rateCell.appendChild(bar);
    } else {
      rateCell.textContent = '\\u2014';
      rateCell.style.color = 'var(--text-dim)';
    }
    row.appendChild(rateCell);

    row.appendChild(el('td', {
      text: st.lastRun ? new Date(st.lastRun).toLocaleDateString() : '\\u2014',
      style:'color:var(--text-dim);font-size:12px'
    }));

    tbody.appendChild(row);

    if (hasDesc) {
      const expRow = el('tr', {id: expanderId, class:'expander-row', 'data-slug': check.slug, 'data-tags': (check.tags || []).join(','), 'data-source': check.source, 'data-name': check.name.toLowerCase()});
      const expCell = el('td', {colspan:'8', style:'padding:0'});
      const expContent = el('div', {class:'expander-content'});
      expContent.appendChild(renderLongDesc(check.longDescription));
      expCell.appendChild(expContent);
      expRow.appendChild(expCell);
      tbody.appendChild(expRow);
    }
  });

  table.appendChild(tbody);
  const pag = el('div', {class:'pagination'});
  const card = el('div', {class:'card'}, [table, pag]);
  panel.appendChild(card);

  const emptyMsg = el('div', {class:'empty', style:'display:none', text:'No checks match your filters.'});
  card.insertBefore(emptyMsg, pag);
  paginateGroupedRows(tbody, pag, 10);

  function applyFilters() {
    const search = searchInput.value.toLowerCase();
    const tag = tagSelect.value;
    const source = sourceSelect.value;
    const allRows = Array.from(tbody.children);
    let visibleCount = 0;

    // First pass: mark rows visible/hidden and collapse expanders
    for (let i = 0; i < allRows.length; i++) {
      const row = allRows[i];
      if (row.classList.contains('expander-row')) continue;
      const slug = row.getAttribute('data-slug') || '';
      const name = row.getAttribute('data-name') || '';
      const rowTags = row.getAttribute('data-tags') || '';
      const rowSource = row.getAttribute('data-source') || '';
      const matchSearch = !search || slug.includes(search) || name.includes(search);
      const matchTag = !tag || rowTags.split(',').includes(tag);
      const matchSource = !source || rowSource === source;
      const visible = matchSearch && matchTag && matchSource;
      row.style.display = visible ? '' : 'none';
      row._filterVisible = visible;
      if (visible) visibleCount++;
      if (i + 1 < allRows.length && allRows[i + 1].classList.contains('expander-row')) {
        allRows[i + 1].style.display = 'none';
        allRows[i + 1].classList.remove('open');
        if (row.classList.contains('expanded')) {
          row.classList.remove('expanded');
          const arrowTd = row.children[0];
          if (arrowTd) arrowTd.textContent = '\\u25B6';
        }
      }
    }
    emptyMsg.style.display = visibleCount === 0 ? '' : 'none';

    // Re-paginate only visible rows
    const hasFilters = search || tag || source;
    if (hasFilters) {
      // Hide all first, then paginate only matching groups
      const groups = [];
      for (let i = 0; i < allRows.length; i++) {
        const row = allRows[i];
        if (row.classList.contains('expander-row')) continue;
        if (!row._filterVisible) continue;
        const group = [row];
        if (i + 1 < allRows.length && allRows[i+1].classList.contains('expander-row')) {
          group.push(allRows[i+1]);
        }
        groups.push(group);
      }

      // Custom pagination for filtered results
      let currentPage = 0;
      const pageSize = 10;
      const totalPages = Math.max(1, Math.ceil(groups.length / pageSize));

      function renderFilteredPage() {
        // Hide all filtered rows first
        groups.forEach(g => g.forEach(r => { r.style.display = 'none'; }));
        const start = currentPage * pageSize;
        const end = start + pageSize;
        groups.slice(start, end).forEach(g => { g[0].style.display = ''; });

        while (pag.firstChild) pag.removeChild(pag.firstChild);
        if (groups.length <= pageSize) return;
        pag.appendChild(el('div', {class:'pagination-info', text: 'Showing ' + (start+1) + '-' + Math.min(end, groups.length) + ' of ' + groups.length + ' checks'}));
        const btns = el('div', {class:'pagination-btns'});
        renderPageButtons(btns, currentPage, totalPages, (p) => { currentPage = p; renderFilteredPage(); });
        pag.appendChild(btns);
      }
      renderFilteredPage();
    } else {
      paginateGroupedRows(tbody, pag, 10);
    }
  }

  searchInput.addEventListener('input', applyFilters);
  tagSelect.addEventListener('change', applyFilters);
  sourceSelect.addEventListener('change', applyFilters);
}
`;
}
