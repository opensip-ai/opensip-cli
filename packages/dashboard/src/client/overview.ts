/**
 * Overview tab — cross-tool recent activity table.
 *
 * Recent Activity is ledger-only: top-level rows come from host-owned
 * `Run` records and child rows come from their `RunStep`s. Linked
 * `StoredSession` rows are optional detail/navigation artifacts, never a
 * fallback source for reconstructing missing overview rows.
 *
 * The `toolBadgeStyles` (tool → inline badge style) and `tabMap` (tool → tab id)
 * maps are derived from the first-party tab descriptors in `generator.ts` and
 * injected as page globals (see globals.d.ts) — every named tool tab contributes
 * one entry to each. Adding a first-party tab changes the descriptor list; the
 * maps update automatically (F1/F8).
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 * `renderOverview` stays exposed as a page global because generator.ts invokes
 * it by bare name in the report's render block.
 */

import { el } from './el.js';
import { appendLedgerRows } from './overview-ledger.js';
import { paginateGroupedRows } from './pagination.js';
import { activateTabForSession } from './tab-activators.js';
import { activateReportTab } from './tab-bar.js';

const DEFAULT_TOOL_BADGE_STYLE = 'background:var(--bg-hover);color:var(--text-muted)';

function activateSession(s: DashboardSession): void {
  // Tabs that need session-aware deep-linking (Code Paths today; future fit/sim
  // detail views) register an activator into the shared tabActivators registry.
  // If one matches this session's tool, hand off to it. Otherwise fall back to
  // plain top-level tab switching by name.
  if (activateTabForSession(s)) return;
  // Route to the session's per-tool tab, or — for a tool not claimed by any
  // registered tab (external-adapter scans) — the host-owned catch-all
  // "External Tools" tab. Resolve the targets BEFORE deactivating anything:
  // if neither a tab nor a panel exists for the route, no-op (leave the
  // current view intact) rather than deactivating every panel — including
  // #panel-overview — and activating nothing, which would blank the report.
  const tabName = s.tool in tabMap ? tabMap[s.tool] : externalTabId;
  activateReportTab(tabName);
}

function appendToolBadge(cell: HTMLElement, tool: string): void {
  cell.append(
    el('span', {
      class: 'badge',
      style: toolBadgeStyles[tool] ?? DEFAULT_TOOL_BADGE_STYLE,
      text: tool.toUpperCase(),
    }),
  );
}

function appendRecentActivityRows(tbody: HTMLElement): void {
  appendLedgerRows(tbody, runs, sessions, {
    appendToolBadge,
    activateSession,
  });
}

export function renderOverview(): void {
  const panel = document.querySelector('#panel-overview');
  if (!panel) return;
  if (runs.length === 0) {
    panel.append(el('div', { class: 'empty', text: 'No runs yet.' }));
    return;
  }

  const sec = el('div', { class: 'section' }, [el('h3', { text: 'Recent Activity' })]);
  const table = el('table', { class: 'data-table sortable' });
  const thead = el('thead');
  const headerRow = el('tr');
  [
    '',
    'Timestamp',
    'Run',
    'Recipe',
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
  appendRecentActivityRows(tbody);
  table.append(tbody);
  const pag = el('div', { class: 'pagination' });
  pag.dataset.pageItemLabel = 'runs';
  sec.append(el('div', { class: 'card' }, [table, pag]));
  panel.append(sec);
  paginateGroupedRows(tbody, pag, 10);
}
