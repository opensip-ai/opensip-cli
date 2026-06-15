/**
 * Session table + session detail rendering — used by fitness/sim tabs.
 * Returns JS code as a string.
 */

export function dashboardSessionsJs(): string {
  return String.raw`
// =======================================================
// SESSION TABLE (used by fitness/sim tabs)
// =======================================================

// Per-rule metric column map for the expanded findings table. For these
// graph rules the finding message just repeats the file + the metric, so
// we DROP the Message column and render a dedicated metric column read
// from finding.metadata (persisted on the signal metadata payload).
const RULE_METRIC_COLUMNS = {
  'graph:large-function': { label: 'Lines', key: 'bodyLines' },
  'graph:high-blast-untested': { label: 'Score', key: 'blast' },
  'graph:wide-function': { label: 'Parameters', key: 'paramCount' },
  'graph:cycle': { label: 'Call Cycle', key: 'sccSize' },
};

/** Derive 3-state session status: 'fail' | 'warn' | 'pass'
 *  Counts live in the tool-owned opaque payload (summary). */
function sessionStatus(s) {
  const sm = (s.payload && s.payload.summary) || {};
  if (sm.failed > 0) return 'fail';
  if (sm.warnings > 0) return 'warn';
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
    const sm = (s.payload && s.payload.summary) || { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 };
    const row = el('tr', {class:'clickable', id: 'session-row-' + tool + '-' + idx, 'data-session-id': s.id, onclick: () => {
      tbody.querySelectorAll('tr.selected').forEach(r => r.classList.remove('selected'));
      row.classList.add('selected');
      renderDetail(s, idx);
    }});
    row.appendChild(el('td', {class:'cell-nowrap', text: new Date(s.startedAt).toLocaleString()}));
    row.appendChild(el('td', {text: s.recipe || 'default', style:'color:var(--text-muted)'}));
    const scoreCell = el('td', {style: 'font-weight:600;' + sc});
    scoreCell.textContent = s.score + '%';
    row.appendChild(scoreCell);
    const badgeCell = el('td');
    badgeCell.appendChild(statusBadge(sessionStatus(s)));
    row.appendChild(badgeCell);
    row.appendChild(el('td', {text: ''+sm.passed, style:'color:var(--success)'}));
    row.appendChild(el('td', {text: ''+sm.failed, style: sm.failed > 0 ? 'color:var(--error)' : 'color:var(--text-dim)'}));
    row.appendChild(el('td', {text: ''+(sm.errors + (sm.warnings || 0))}));
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

    // Sessions written before the tool-owned payload split (or by a tool
    // that records no per-item detail) have no payload at all. Distinguish
    // that from "payload present but empty" so the panel says so explicitly
    // rather than rendering a silent empty table.
    if (!session.payload) {
      detailContainer.appendChild(el('h3', {text: 'Session Detail — ' + new Date(session.startedAt).toLocaleString(), style:'margin-bottom:4px'}));
      detailContainer.appendChild(el('div', {class:'empty', text:'No detail recorded for this session.'}));
      return;
    }

    // Per-item detail lives in the tool-owned opaque payload. Fitness calls
    // these "checks"; graph groups signals by rule (relabeled below).
    const checks = (session.payload && session.payload.checks) || [];

    // A payload that records no per-item rows (e.g. a clean graph run — graph
    // only persists rules that emitted a finding) would otherwise render a
    // header-only table that reads as "nothing shows up". Render an explicit
    // empty state instead so a clean run is unambiguous.
    if (checks.length === 0) {
      detailContainer.appendChild(el('h3', {text: 'Session Detail — ' + new Date(session.startedAt).toLocaleString(), style:'margin-bottom:4px'}));
      const sm = (session.payload && session.payload.summary) || {};
      const clean = !((sm.errors || 0) > 0 || (sm.warnings || 0) > 0);
      const subline = el('div', {style:'color:var(--text-dim);font-size:12px;margin-bottom:12px'});
      subline.textContent = session.cwd + (session.recipe ? ' — recipe: ' + session.recipe : '');
      detailContainer.appendChild(subline);
      detailContainer.appendChild(el('div', {class:'empty', text: clean
        ? 'No findings — this run was clean. Every rule passed with zero violations.'
        : 'No per-rule detail was recorded for this run.'}));
      return;
    }

    // Compute session-level totals from check findings
    let totalErrors = 0;
    let totalWarnings = 0;
    checks.forEach(c => {
      if (c.findings) {
        c.findings.forEach(f => {
          if (f.severity === 'error') totalErrors++;
          else if (f.severity === 'warning') totalWarnings++;
        });
      }
    });

    const headerRow = el('div', {style:'display:flex;align-items:center;justify-content:space-between;margin-bottom:16px'});
    const headerLeft = el('div');
    headerLeft.appendChild(el('h3', {text: 'Session Detail \u2014 ' + new Date(session.startedAt).toLocaleString(), style:'margin-bottom:4px'}));
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
    // Graph groups findings by rule, not by check — relabel that one
    // column so the header reads in the tool's own vocabulary. The
    // structural payload shape is identical; only the label differs.
    const itemColumn = tool === 'graph' ? 'Rule' : 'Check';
    // Graph rules are dataset queries, not timed units — their per-rule
    // duration is always 0ms, so drop the Duration column for graph
    // sessions. Fitness/sim checks ARE timed; keep it for them.
    const showDuration = tool !== 'graph';
    const itemHeaders = ['', itemColumn, 'Status', 'Errors', 'Warnings', 'Findings'];
    if (showDuration) itemHeaders.push('Duration');
    itemHeaders.forEach(h => {
      thRow.appendChild(el('th', {text: h}));
    });
    thead.appendChild(thRow);
    table.appendChild(thead);

    const tbody = el('tbody');
    // Sort rules/checks by severity weight: most errors first, then by
    // warning count as a tiebreak (error-then-warning, stable).
    const sortedChecks = [...checks].sort((a, b) => {
      const aErrors = a.findings ? a.findings.filter(f => f.severity === 'error').length : 0;
      const bErrors = b.findings ? b.findings.filter(f => f.severity === 'error').length : 0;
      if (bErrors !== aErrors) return bErrors - aErrors;
      const aWarn = a.findings ? a.findings.filter(f => f.severity === 'warning').length : 0;
      const bWarn = b.findings ? b.findings.filter(f => f.severity === 'warning').length : 0;
      return bWarn - aWarn;
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
      if (showDuration) row.appendChild(el('td', {text: check.durationMs > 0 ? check.durationMs + 'ms' : '0ms', style:'color:var(--text-dim)'}));
      tbody.appendChild(row);

      if (hasFindings) {
        const expRow = el('tr', {id: expanderId, class:'expander-row', 'data-check-status': checkStatusVal});
        const expCell = el('td', {colspan: '' + itemHeaders.length, style:'padding:0'});
        const expContent = el('div', {class:'expander-content'});

        const fTable = el('table', {class:'data-table', style:'margin:0;border:none'});
        const fHead = el('thead');
        const fHeaderRow = el('tr');
        // Per-rule column shape. Most rules render the default
        // [Severity, Message, File, Suggestion]. The graph metric rules
        // below repeat the file + metric in their message, so they DROP
        // Message and ADD a metric column read from finding.metadata.
        const metricColumn = RULE_METRIC_COLUMNS[check.checkSlug];
        const fHeaders = metricColumn
          ? ['Severity', 'File', metricColumn.label, 'Suggestion']
          : ['Severity', 'Message', 'File', 'Suggestion'];
        fHeaders.forEach(h => {
          fHeaderRow.appendChild(el('th', {text: h, style:'font-size:11px;padding:6px 12px'}));
        });
        fHead.appendChild(fHeaderRow);
        fTable.appendChild(fHead);

        const fBody = el('tbody');
        // Sort findings within the rule: errors first, then warnings (stable).
        const sevWeight = { error: 0, warning: 1 };
        const sortedFindings = [...check.findings].sort((a, b) =>
          (sevWeight[a.severity] ?? 2) - (sevWeight[b.severity] ?? 2));
        sortedFindings.forEach(f => {
          const fRow = el('tr');
          const sevCell = el('td', {style:'padding:6px 12px'});
          sevCell.appendChild(el('span', {class:'finding-sev ' + f.severity, text: f.severity}));
          fRow.appendChild(sevCell);
          const fileText = f.filePath ? f.filePath + (f.line ? ':' + f.line : '') : '\u2014';
          if (metricColumn) {
            fRow.appendChild(el('td', {text: fileText, style:'padding:6px 12px;color:var(--text-dim);font-size:12px'}));
            const mv = f.metadata ? f.metadata[metricColumn.key] : undefined;
            fRow.appendChild(el('td', {text: (mv === undefined || mv === null) ? '\u2014' : '' + mv, style:'padding:6px 12px;font-size:13px'}));
          } else {
            fRow.appendChild(el('td', {text: f.message, style:'padding:6px 12px;font-size:13px'}));
            fRow.appendChild(el('td', {text: fileText, style:'padding:6px 12px;color:var(--text-dim);font-size:12px'}));
          }
          fRow.appendChild(el('td', {text: f.suggestion || '\u2014', style:'padding:6px 12px;color:var(--accent);font-size:12px'}));
          fBody.appendChild(fRow);
        });
        fTable.appendChild(fBody);
        // Wrap the wide findings table in a horizontal-scroll container so
        // long file paths / messages scroll inside the card instead of
        // overrunning the section (mirrors the .coupling-scroll fix).
        const fScroll = el('div', {style:'overflow-x:auto;max-width:100%'}, [fTable]);
        expContent.appendChild(fScroll);
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
