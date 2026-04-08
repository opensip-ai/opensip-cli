/**
 * Session table + session detail rendering — used by fitness/sim tabs.
 * Returns JS code as a string.
 */

export function dashboardSessionsJs(): string {
  return `
// =======================================================
// SESSION TABLE (used by fitness/sim tabs)
// =======================================================

/** Derive 3-state session status: 'fail' | 'warn' | 'pass' */
function sessionStatus(s) {
  if (s.summary.failed > 0) return 'fail';
  if (s.summary.warnings > 0) return 'warn';
  return 'pass';
}

function statusBadge(status) {
  const labels = { fail: 'FAIL', warn: 'WARN', pass: 'PASS' };
  const classes = { fail: 'badge-fail', warn: 'badge-warn', pass: 'badge-pass' };
  return el('span', {class:'badge ' + classes[status], text: labels[status]});
}

function renderSessionTable(panel, toolSessions, accentColor) {
  if (!toolSessions.length) {
    panel.appendChild(el('div', {class:'empty', text:'No sessions yet.'}));
    return;
  }

  const tool = toolSessions[0].tool;

  const table = el('table', {class:'data-table sortable'});
  const thead = el('thead');
  const headerRow = el('tr');
  ['Timestamp', 'Recipe', 'Pass Rate', 'Status', 'Passed', 'Failed', 'Findings', 'Duration'].forEach(h => {
    headerRow.appendChild(el('th', {text: h}));
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  toolSessions.forEach((s, idx) => {
    const sc = s.score >= 90 ? 'color:var(--success)' : s.score >= 70 ? 'color:var(--warning)' : 'color:var(--error)';
    const row = el('tr', {class:'clickable', id: 'session-row-' + tool + '-' + idx, onclick: () => {
      document.querySelectorAll('#' + detailContainer.id + ' .data-table tr.selected').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      renderDetail(s, idx);
    }});
    row.appendChild(el('td', {text: new Date(s.timestamp).toLocaleString()}));
    row.appendChild(el('td', {text: s.recipe || 'default', style:'color:var(--text-muted)'}));
    const scoreCell = el('td', {style: 'font-weight:600;' + sc});
    scoreCell.textContent = s.score + '%';
    row.appendChild(scoreCell);
    const badgeCell = el('td');
    badgeCell.appendChild(statusBadge(sessionStatus(s)));
    row.appendChild(badgeCell);
    row.appendChild(el('td', {text: ''+s.summary.passed, style:'color:var(--success)'}));
    row.appendChild(el('td', {text: ''+s.summary.failed, style: s.summary.failed > 0 ? 'color:var(--error)' : 'color:var(--text-dim)'}));
    row.appendChild(el('td', {text: ''+s.summary.errors}));
    row.appendChild(el('td', {text: (s.durationMs/1000).toFixed(1)+'s', style:'color:var(--text-dim)'}));
    tbody.appendChild(row);
  });
  table.appendChild(tbody);

  const sessionPag = el('div', {class:'pagination'});
  const sec = el('div', {class:'section'}, [el('h3', {text:'Sessions (' + toolSessions.length + ')'}), el('div', {class:'card'}, [table, sessionPag])]);
  panel.appendChild(sec);
  paginateTable(tbody, sessionPag, 10);

  // Detail container — kept as a direct reference, no global ID lookup needed
  const detailContainer = el('div', {id: 'detail-' + tool + '-' + Math.random().toString(36).slice(2,8), class:'section', style:'display:none'});
  panel.appendChild(detailContainer);

  function renderDetail(session, idx) {
    detailContainer.style.display = 'block';
    while (detailContainer.firstChild) detailContainer.removeChild(detailContainer.firstChild);

    // Compute session-level totals from check findings
    let totalErrors = 0;
    let totalWarnings = 0;
    session.checks.forEach(c => {
      if (c.findings) {
        c.findings.forEach(f => {
          if (f.severity === 'error') totalErrors++;
          else if (f.severity === 'warning') totalWarnings++;
        });
      }
    });

    const headerRow = el('div', {style:'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px'});
    const headerLeft = el('div');
    headerLeft.appendChild(el('h3', {text: 'Session Detail \\u2014 ' + new Date(session.timestamp).toLocaleString(), style:'margin-bottom:4px'}));
    const sub = el('div', {style:'color:var(--text-dim);font-size:12px'});
    const countParts = [];
    if (totalErrors > 0) countParts.push(totalErrors + ' error' + (totalErrors !== 1 ? 's' : ''));
    if (totalWarnings > 0) countParts.push(totalWarnings + ' warning' + (totalWarnings !== 1 ? 's' : ''));
    const countsStr = countParts.length > 0 ? ' \\u2014 ' + countParts.join(', ') : '';
    sub.textContent = session.cwd + (session.recipe ? ' \\u2014 recipe: ' + session.recipe : '') + countsStr;
    headerLeft.appendChild(sub);
    headerRow.appendChild(headerLeft);

    // Status filter dropdown
    const filterUid = 'df-' + tool + '-' + idx + '-' + Math.random().toString(36).slice(2,6);
    const select = el('select', {id: filterUid, style:'background:var(--bg-surface);color:var(--text);border:1px solid var(--border);border-radius:var(--radius-sm);padding:4px 8px;font-size:12px;cursor:pointer'});
    [['fail', 'Failed'], ['all', 'All Checks'], ['pass', 'Passed']].forEach(([val, label]) => {
      const opt = el('option', {value: val, text: label});
      if (val === 'fail') opt.setAttribute('selected', 'selected');
      select.appendChild(opt);
    });
    headerRow.appendChild(select);
    detailContainer.appendChild(headerRow);

    // Check detail table
    const table = el('table', {class:'data-table sortable'});
    const thead = el('thead');
    const thRow = el('tr');
    ['', 'Check', 'Status', 'Errors', 'Warnings', 'Findings', 'Duration'].forEach(h => {
      thRow.appendChild(el('th', {text: h}));
    });
    thead.appendChild(thRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    session.checks.forEach((check, i) => {
      const checkErrors = check.findings ? check.findings.filter(f => f.severity === 'error').length : 0;
      const checkWarnings = check.findings ? check.findings.filter(f => f.severity === 'warning').length : 0;
      const findingsTotal = checkErrors + checkWarnings;
      const hasFindings = findingsTotal > 0;
      const expanderId = filterUid + '-exp-' + i;
      const checkStatusVal = check.passed ? 'pass' : 'fail';

      const arrowCell = el('td', {style:'width:24px;text-align:center;color:var(--text-dim);font-size:12px'});
      if (hasFindings) arrowCell.textContent = '\\u25B6';

      const row = el('tr', {class: hasFindings ? 'clickable' : '', 'data-check-status': checkStatusVal, onclick: hasFindings ? () => {
        const exp = document.getElementById(expanderId);
        if (exp) {
          const isOpen = exp.classList.toggle('open');
          exp.style.display = isOpen ? 'table-row' : 'none';
          arrowCell.textContent = isOpen ? '\\u25BC' : '\\u25B6';
        }
        row.classList.toggle('expanded');
      } : undefined});
      row.appendChild(arrowCell);
      row.appendChild(el('td', {text: check.checkSlug, style:'font-weight:500'}));

      const statusCell = el('td');
      statusCell.appendChild(el('span', {class:'badge ' + (check.passed ? 'badge-pass' : 'badge-fail'), text: check.passed ? 'PASS' : 'FAIL'}));
      row.appendChild(statusCell);
      row.appendChild(el('td', {text: ''+checkErrors, style: checkErrors > 0 ? 'color:var(--error)' : 'color:var(--text-dim)'}));
      row.appendChild(el('td', {text: ''+checkWarnings, style: checkWarnings > 0 ? 'color:var(--warning)' : 'color:var(--text-dim)'}));
      row.appendChild(el('td', {text: ''+findingsTotal, style: findingsTotal > 0 ? 'color:var(--text)' : 'color:var(--text-dim)'}));
      row.appendChild(el('td', {text: check.durationMs > 0 ? check.durationMs + 'ms' : '0ms', style:'color:var(--text-dim)'}));
      tbody.appendChild(row);

      if (hasFindings) {
        const expRow = el('tr', {id: expanderId, class:'expander-row', 'data-check-status': checkStatusVal});
        const expCell = el('td', {colspan:'7', style:'padding:0'});
        const expContent = el('div', {class:'expander-content'});

        const fTable = el('table', {class:'data-table', style:'margin:0;border:none'});
        const fHead = el('thead');
        const fHeaderRow = el('tr');
        ['Severity', 'Message', 'File', 'Suggestion'].forEach(h => {
          fHeaderRow.appendChild(el('th', {text: h, style:'font-size:11px;padding:6px 12px'}));
        });
        fHead.appendChild(fHeaderRow);
        fTable.appendChild(fHead);

        const fBody = el('tbody');
        check.findings.forEach(f => {
          const fRow = el('tr');
          const sevCell = el('td', {style:'padding:6px 12px'});
          sevCell.appendChild(el('span', {class:'finding-sev ' + f.severity, text: f.severity}));
          fRow.appendChild(sevCell);
          fRow.appendChild(el('td', {text: f.message, style:'padding:6px 12px;font-size:13px'}));
          fRow.appendChild(el('td', {text: f.filePath ? f.filePath + (f.line ? ':' + f.line : '') : '\\u2014', style:'padding:6px 12px;color:var(--text-dim);font-size:12px'}));
          fRow.appendChild(el('td', {text: f.suggestion || '\\u2014', style:'padding:6px 12px;color:var(--accent);font-size:12px'}));
          fBody.appendChild(fRow);
        });
        fTable.appendChild(fBody);
        expContent.appendChild(fTable);
        expCell.appendChild(expContent);
        expRow.appendChild(expCell);
        tbody.appendChild(expRow);
      }
    });
    table.appendChild(tbody);
    const detailPag = el('div', {class:'pagination'});
    detailContainer.appendChild(el('div', {class:'card'}, [table, detailPag]));

    // Enable sorting on the detail table
    makeSortable(table);

    // Apply filter
    applyCheckFilter(select, tbody, detailPag);
    select.addEventListener('change', () => applyCheckFilter(select, tbody, detailPag));
  }

  // Auto-show latest
  renderDetail(toolSessions[0], 0);
}

function applyCheckFilter(select, tbody, pagContainer) {
  const filter = select.value;
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

  const filtered = groups.filter(group => {
    const status = group[0].getAttribute('data-check-status');
    if (filter === 'all') return true;
    return status === filter;
  });

  groups.forEach(group => group.forEach(row => { row.style.display = 'none'; }));

  let currentPage = 0;
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));

  function renderPage() {
    const start = currentPage * pageSize;
    const end = start + pageSize;
    filtered.forEach(group => group.forEach(row => { row.style.display = 'none'; }));
    filtered.slice(start, end).forEach(group => {
      group[0].style.display = '';
      if (group[1] && group[1].classList.contains('open')) group[1].style.display = '';
    });

    while (pagContainer.firstChild) pagContainer.removeChild(pagContainer.firstChild);
    if (filtered.length <= pageSize) return;

    pagContainer.appendChild(el('div', {class:'pagination-info', text: 'Showing ' + (start+1) + '-' + Math.min(end, filtered.length) + ' of ' + filtered.length + ' checks'}));
    const btns = el('div', {class:'pagination-btns'});
    renderPageButtons(btns, currentPage, totalPages, (p) => { currentPage = p; renderPage(); });
    pagContainer.appendChild(btns);
  }
  renderPage();
}
`;
}
