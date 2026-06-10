/**
 * Overview tab — cross-tool recent activity table.
 * Returns JS code as a string.
 *
 * The `toolBadgeStyles` and `tabMap` literals spliced into the emitted
 * JS are derived from the `defineToolTab` registry rather than
 * hard-coded — every registered tool tab contributes one entry to
 * each map. Adding a new tool is a `defineToolTab` call; this
 * function picks it up automatically. (F1/F8.)
 */

import { listToolTabs } from './tool-tab-registry.js';
import './tool-tabs-registrations.js'; // side-effect: registers fit/sim/graph

export function dashboardOverviewJs(): string {
  const toolTabs = listToolTabs();
  const badgeStylesEntries = toolTabs
    .map((t) => `    ${JSON.stringify(t.tool)}: ${JSON.stringify(t.badgeStyle)},`)
    .join('\n');
  const tabMapEntries = toolTabs
    .map((t) => `${JSON.stringify(t.tool)}: ${JSON.stringify(t.id)}`)
    .join(', ');
  return `
// =======================================================
// OVERVIEW TAB
// =======================================================
function renderOverview() {
  const panel = document.getElementById('panel-overview');
  if (!sessions.length) { panel.appendChild(el('div', {class:'empty', text:'No sessions yet.'})); return; }

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
  // Derived from the defineToolTab registry — see tool-tab-registry.ts
  // and tool-tabs-registrations.ts. New tools register descriptors;
  // these maps update automatically.
  const toolBadgeStyles = {
${badgeStylesEntries}
  };
  const tabMap = { ${tabMapEntries} };

  sessions.forEach(s => {
    const sc2 = s.score >= 90 ? 'color:var(--success)' : s.score >= 70 ? 'color:var(--warning)' : 'color:var(--error)';
    // Per-session counts live in the tool-owned opaque payload. Tools
    // that persist no summary (or none yet) fall back to zeros so the
    // cross-tool row stays well-formed.
    const sm = (s.payload && s.payload.summary) || { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 };
    const row = el('tr', {class:'clickable', onclick: () => {
      // Tabs that need session-aware deep-linking (Code Paths today;
      // future fit/sim detail views) register an activator into the
      // shared tabActivators registry. If one matches this session's
      // tool, hand off to it. Otherwise fall back to plain top-level
      // tab switching by name.
      if (activateTabForSession(s)) return;
      const tabName = tabMap[s.tool] || s.tool;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      const tab = document.querySelector('.tab[data-tab="' + tabName + '"]');
      if (tab) tab.classList.add('active');
      const panel = document.getElementById('panel-' + tabName);
      if (panel) panel.classList.add('active');
    }});
    row.appendChild(el('td', {class:'cell-nowrap', text: new Date(s.timestamp).toLocaleString(), style:'color:var(--text-dim)'}));
    const toolCell = el('td');
    toolCell.appendChild(el('span', {class:'badge', style: toolBadgeStyles[s.tool] || '', text: s.tool.toUpperCase()}));
    row.appendChild(toolCell);
    row.appendChild(el('td', {text: s.recipe || 'default', style:'color:var(--text-muted)'}));
    row.appendChild(el('td', {text: s.score+'%', style:'font-weight:600;'+sc2}));
    const statusCell = el('td');
    statusCell.appendChild(statusBadge(sessionStatus(s)));
    row.appendChild(statusCell);
    row.appendChild(el('td', {text: sm.passed+'/'+sm.total}));
    row.appendChild(el('td', {text: ''+(sm.errors + (sm.warnings || 0))}));
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
