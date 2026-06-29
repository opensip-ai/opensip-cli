/**
 * Overview tab — cross-tool recent activity table.
 *
 * The `toolBadgeStyles` (tool → inline badge style) and `tabMap` (tool → tab id)
 * maps are derived from the `defineToolTab` registry in `generator.ts` and
 * injected as page globals (see globals.d.ts) — every registered tool tab
 * contributes one entry to each. Adding a new tool is a `defineToolTab` call;
 * the maps update automatically (F1/F8).
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 * `renderOverview` stays exposed as a page global because generator.ts invokes
 * it by bare name in the report's render block.
 */

import { el } from './el.js';
import { paginateTable } from './pagination.js';
import { scoreColorStyle, sessionStatus, statusBadge } from './sessions.js';
import { activateTabForSession } from './tab-activators.js';

export function renderOverview(): void {
  const panel = document.querySelector('#panel-overview');
  if (!panel) return;
  if (sessions.length === 0) {
    panel.append(el('div', { class: 'empty', text: 'No sessions yet.' }));
    return;
  }

  const sec = el('div', { class: 'section' }, [el('h3', { text: 'Recent Activity' })]);
  const table = el('table', { class: 'data-table sortable' });
  const thead = el('thead');
  const headerRow = el('tr');
  [
    'Timestamp',
    'Tool',
    'Recipe',
    'Suite',
    'Pass Rate',
    'Status',
    'Checks',
    'Findings',
    'Duration',
  ].forEach((h) => {
    headerRow.append(el('th', { text: h }));
  });
  thead.append(headerRow);
  table.append(thead);

  const tbody = el('tbody');
  let lastSuiteRunId: string | undefined;
  sessions.forEach((s) => {
    if (s.suiteRunId !== undefined && s.suiteRunId !== lastSuiteRunId) {
      lastSuiteRunId = s.suiteRunId;
      const label = s.suiteName ?? s.suiteRunId;
      const header = el('tr', { class: 'suite-group-header' });
      const cell = el('td', {
        text: 'Suite: ' + label,
        colSpan: '9',
        style: 'font-weight:600;color:var(--text-muted);background:var(--surface-2)',
      });
      header.append(cell);
      tbody.append(header);
    } else if (s.suiteRunId === undefined) {
      lastSuiteRunId = undefined;
    }
    const sc2 = scoreColorStyle(s.score);
    // Per-session counts live in the tool-owned opaque payload. Tools that
    // persist no summary (or none yet) fall back to zeros so the cross-tool row
    // stays well-formed.
    const sm = s.payload?.summary ?? { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 };
    const row = el('tr', {
      class: 'clickable',
      onclick: () => {
        // Tabs that need session-aware deep-linking (Code Paths today; future
        // fit/sim detail views) register an activator into the shared
        // tabActivators registry. If one matches this session's tool, hand off
        // to it. Otherwise fall back to plain top-level tab switching by name.
        if (activateTabForSession(s)) return;
        // Route to the session's per-tool tab, or — for a tool not claimed by any
        // registered tab (external-adapter scans) — the host-owned catch-all
        // "External Tools" tab. Resolve the targets BEFORE deactivating anything:
        // if neither a tab nor a panel exists for the route, no-op (leave the
        // current view intact) rather than deactivating every panel — including
        // #panel-overview — and activating nothing, which would blank the report.
        const tabName = s.tool in tabMap ? tabMap[s.tool] : externalTabId;
        const tab = document.querySelector('.tab[data-tab="' + tabName + '"]');
        const activePanel = document.querySelector('#panel-' + tabName);
        if (!tab && !activePanel) return;
        document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
        if (tab) tab.classList.add('active');
        if (activePanel) activePanel.classList.add('active');
      },
    });
    row.append(
      el('td', {
        class: 'cell-nowrap',
        text: new Date(s.startedAt).toLocaleString(),
        style: 'color:var(--text-dim)',
      }),
    );
    const toolCell = el('td');
    toolCell.append(
      el('span', {
        class: 'badge',
        style: toolBadgeStyles[s.tool] ?? '',
        text: s.tool.toUpperCase(),
      }),
    );
    row.append(toolCell);
    row.append(el('td', { text: s.recipe ?? 'default', style: 'color:var(--text-muted)' }));
    row.append(
      el('td', {
        text: s.suiteName ?? '—',
        title: s.suiteRunId ?? '',
        style: s.suiteName === undefined ? 'color:var(--text-dim)' : 'color:var(--text-muted)',
      }),
    );
    row.append(el('td', { text: s.score + '%', style: 'font-weight:600;' + sc2 }));
    const statusCell = el('td');
    statusCell.append(statusBadge(sessionStatus(s)));
    row.append(statusCell);
    row.append(el('td', { text: (sm.passed ?? 0) + '/' + (sm.total ?? 0) }));
    row.append(el('td', { text: '' + ((sm.errors ?? 0) + (sm.warnings ?? 0)) }));
    row.append(
      el('td', { text: (s.durationMs / 1000).toFixed(1) + 's', style: 'color:var(--text-dim)' }),
    );
    tbody.append(row);
  });
  table.append(tbody);
  const pag = el('div', { class: 'pagination' });
  sec.append(el('div', { class: 'card' }, [table, pag]));
  panel.append(sec);
  paginateTable(tbody, pag, 10);
}
