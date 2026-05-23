/**
 * Session table + session detail rendering — used by fitness/sim tabs.
 * Returns JS code as a string.
 */

export function dashboardSessionsJs(): string {
  return String.raw`
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
    const row = el('tr', {class:'clickable', id: 'session-row-' + tool + '-' + idx, 'data-session-id': s.id, onclick: () => {
      tbody.querySelectorAll('tr.selected').forEach(r => r.classList.remove('selected'));
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
    row.appendChild(el('td', {text: ''+(s.summary.errors + (s.summary.warnings || 0))}));
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
    headerLeft.appendChild(el('h3', {text: 'Session Detail \u2014 ' + new Date(session.timestamp).toLocaleString(), style:'margin-bottom:4px'}));
    const sub = el('div', {style:'color:var(--text-dim);font-size:12px'});
    const countParts = [];
    if (totalErrors > 0) countParts.push(totalErrors + ' error' + (totalErrors !== 1 ? 's' : ''));
    if (totalWarnings > 0) countParts.push(totalWarnings + ' warning' + (totalWarnings !== 1 ? 's' : ''));
    const countsStr = countParts.length > 0 ? ' \u2014 ' + countParts.join(', ') : '';
    sub.textContent = session.cwd + (session.recipe ? ' \u2014 recipe: ' + session.recipe : '') + countsStr;
    headerLeft.appendChild(sub);
    headerRow.appendChild(headerLeft);

    detailContainer.appendChild(headerRow);
    const filterUid = 'df-' + tool + '-' + idx + '-' + Math.random().toString(36).slice(2,6);

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
    const sortedChecks = [...session.checks].sort((a, b) => {
      const aErrors = a.findings ? a.findings.filter(f => f.severity === 'error').length : 0;
      const bErrors = b.findings ? b.findings.filter(f => f.severity === 'error').length : 0;
      return bErrors - aErrors;
    });
    sortedChecks.forEach((check, i) => {
      const checkErrors = check.findings ? check.findings.filter(f => f.severity === 'error').length : 0;
      const checkWarnings = check.findings ? check.findings.filter(f => f.severity === 'warning').length : 0;
      const findingsTotal = checkErrors + checkWarnings;
      const hasFindings = findingsTotal > 0;
      const expanderId = filterUid + '-exp-' + i;
      const checkStatusVal = check.passed ? 'pass' : 'fail';

      const arrowCell = el('td', {style:'width:24px;text-align:center;color:var(--text-dim);font-size:12px'});
      if (hasFindings) arrowCell.textContent = '\u25B6';

      const row = el('tr', {class: hasFindings ? 'clickable' : '', 'data-check-status': checkStatusVal, onclick: hasFindings ? () => {
        const exp = document.getElementById(expanderId);
        if (exp) {
          const isOpen = exp.classList.toggle('open');
          exp.style.display = isOpen ? 'table-row' : 'none';
          arrowCell.textContent = isOpen ? '\u25BC' : '\u25B6';
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
          fRow.appendChild(el('td', {text: f.filePath ? f.filePath + (f.line ? ':' + f.line : '') : '\u2014', style:'padding:6px 12px;color:var(--text-dim);font-size:12px'}));
          fRow.appendChild(el('td', {text: f.suggestion || '\u2014', style:'padding:6px 12px;color:var(--accent);font-size:12px'}));
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

    // Paginate
    paginateGroupedRows(tbody, detailPag, 10);
  }

  // Auto-show latest and highlight first row
  renderDetail(toolSessions[0], 0);
  const firstRow = tbody.querySelector('tr');
  if (firstRow) firstRow.classList.add('selected');
}


`;
}
