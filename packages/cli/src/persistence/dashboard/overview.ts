/**
 * Overview tab — cross-tool recent activity table.
 * Returns JS code as a string.
 */

export function dashboardOverviewJs(): string {
  return `
// =======================================================
// OVERVIEW TAB
// =======================================================
function renderOverview() {
  const panel = document.getElementById('panel-overview');
  if (!sessions.length) { panel.appendChild(el('div', {class:'empty', text:'No sessions yet. Run opensip-tools fit to generate data.'})); return; }

  const sec = el('div', {class:'section'}, [el('h3', {text:'Recent Activity'})]);
  const table = el('table', {class:'data-table sortable'});
  const thead = el('thead');
  const headerRow = el('tr');
  ['Timestamp', 'Tool', 'Recipe', 'Pass Rate', 'Status', 'Checks', 'Findings', 'Duration'].forEach(h => {
    headerRow.appendChild(el('th', {text: h}));
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  const toolBadgeStyles = {
    fit: 'background:rgba(124,160,104,0.15);color:var(--accent-fitness)',
    sim: 'background:rgba(155,138,165,0.15);color:var(--accent-sim)',
  };
  const tabMap = { fit: 'fitness', sim: 'simulation' };

  sessions.forEach(s => {
    const sc2 = s.score >= 90 ? 'color:var(--success)' : s.score >= 70 ? 'color:var(--warning)' : 'color:var(--error)';
    const row = el('tr', {class:'clickable', onclick: () => {
      // Navigate to the tool's tab
      const tabName = tabMap[s.tool] || s.tool;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      const tab = document.querySelector('.tab[data-tab="' + tabName + '"]');
      if (tab) tab.classList.add('active');
      const panel = document.getElementById('panel-' + tabName);
      if (panel) panel.classList.add('active');
    }});
    row.appendChild(el('td', {text: new Date(s.timestamp).toLocaleString(), style:'color:var(--text-dim)'}));
    const toolCell = el('td');
    toolCell.appendChild(el('span', {class:'badge', style: toolBadgeStyles[s.tool] || '', text: s.tool.toUpperCase()}));
    row.appendChild(toolCell);
    row.appendChild(el('td', {text: s.recipe || 'default', style:'color:var(--text-muted)'}));
    row.appendChild(el('td', {text: s.score+'%', style:'font-weight:600;'+sc2}));
    const statusCell = el('td');
    statusCell.appendChild(statusBadge(sessionStatus(s)));
    row.appendChild(statusCell);
    row.appendChild(el('td', {text: s.summary.passed+'/'+s.summary.total}));
    row.appendChild(el('td', {text: ''+s.summary.errors}));
    row.appendChild(el('td', {text: (s.durationMs/1000).toFixed(1)+'s', style:'color:var(--text-dim)'}));
    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  const pag = el('div', {class:'pagination'});
  sec.appendChild(el('div', {class:'card'}, [table, pag]));
  panel.appendChild(sec);
  paginateTable(tbody, pag, 10);
}
`;
}
