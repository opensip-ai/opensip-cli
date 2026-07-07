/**
 * Overview tab — cross-tool recent activity table.
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
import { paginateGroupedRows } from './pagination.js';
import { scoreColorStyle, sessionStatus, statusBadge } from './sessions.js';
import { activateTabForSession } from './tab-activators.js';

const DEFAULT_TOOL_BADGE_STYLE = 'background:var(--bg-hover);color:var(--text-muted)';
const EMPTY_SUMMARY = { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 } as const;
const DIM_STYLE = 'color:var(--text-dim)';
const MUTED_STYLE = 'color:var(--text-muted)';

type OverviewStatus = Parameters<typeof statusBadge>[0];

interface SummaryCounts {
  total: number;
  passed: number;
  failed: number;
  errors: number;
  warnings: number;
}

function summaryCounts(s: DashboardSession): SummaryCounts {
  const summary = s.payload?.summary ?? EMPTY_SUMMARY;
  return {
    total: summary.total ?? 0,
    passed: summary.passed ?? 0,
    failed: summary.failed ?? 0,
    errors: summary.errors ?? 0,
    warnings: summary.warnings ?? 0,
  };
}

function findingCount(counts: SummaryCounts): number {
  return counts.errors + counts.warnings;
}

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
  const tab = document.querySelector('.tab[data-tab="' + tabName + '"]');
  const activePanel = document.querySelector('#panel-' + tabName);
  if (!tab && !activePanel) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
  if (tab) tab.classList.add('active');
  if (activePanel) activePanel.classList.add('active');
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

function appendSessionCells(row: HTMLElement, s: DashboardSession, child = false): void {
  const counts = summaryCounts(s);
  row.append(el('td', { class: 'overview-row-control' }));
  row.append(
    el('td', {
      class: 'cell-nowrap',
      text: new Date(s.startedAt).toLocaleString(),
      style: DIM_STYLE,
    }),
  );
  const toolCell = el('td', { class: child ? 'overview-suite-child-tool' : '' });
  appendToolBadge(toolCell, s.tool);
  row.append(toolCell);
  row.append(el('td', { text: s.recipe ?? 'default', style: MUTED_STYLE }));
  row.append(
    el('td', { text: s.score + '%', style: 'font-weight:600;' + scoreColorStyle(s.score) }),
  );
  const statusCell = el('td');
  statusCell.append(statusBadge(sessionStatus(s)));
  row.append(statusCell);
  row.append(el('td', { text: counts.passed + '/' + counts.total }));
  row.append(el('td', { text: '' + findingCount(counts) }));
  row.append(el('td', { text: (s.durationMs / 1000).toFixed(1) + 's', style: DIM_STYLE }));
}

function aggregateSuiteCounts(suiteSessions: readonly DashboardSession[]): SummaryCounts {
  return suiteSessions.reduce<SummaryCounts>(
    (acc, s) => {
      const counts = summaryCounts(s);
      acc.total += counts.total;
      acc.passed += counts.passed;
      acc.failed += counts.failed;
      acc.errors += counts.errors;
      acc.warnings += counts.warnings;
      return acc;
    },
    { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 },
  );
}

function aggregateSuiteStatus(suiteSessions: readonly DashboardSession[]): OverviewStatus {
  const statuses = suiteSessions.map((s) => sessionStatus(s));
  if (statuses.includes('error')) return 'error';
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('degraded')) return 'degraded';
  if (statuses.includes('warn')) return 'warn';
  return 'pass';
}

function aggregateSuiteScore(
  suiteSessions: readonly DashboardSession[],
  counts: SummaryCounts,
): number {
  if (counts.total > 0) return Math.round((counts.passed / counts.total) * 100);
  if (suiteSessions.length === 0) return 0;
  const totalScore = suiteSessions.reduce((sum, s) => sum + s.score, 0);
  return Math.round(totalScore / suiteSessions.length);
}

function suiteLabel(suiteSessions: readonly DashboardSession[]): string {
  const [latest] = suiteSessions;
  return (
    suiteSessions.find((s) => s.suiteName !== undefined)?.suiteName ??
    latest?.suiteRunId ??
    'unknown'
  );
}

function groupSuiteSessionsByRunId(
  sourceSessions: readonly DashboardSession[],
): Map<string, DashboardSession[]> {
  const suiteRuns = new Map<string, DashboardSession[]>();
  for (const session of sourceSessions) {
    if (session.suiteRunId === undefined) continue;
    const suiteSessions = suiteRuns.get(session.suiteRunId);
    if (suiteSessions) {
      suiteSessions.push(session);
    } else {
      suiteRuns.set(session.suiteRunId, [session]);
    }
  }
  return suiteRuns;
}

function appendStandaloneRow(tbody: HTMLElement, s: DashboardSession): void {
  const row = el('tr', {
    class: 'clickable overview-session-row',
    onclick: () => activateSession(s),
  });
  appendSessionCells(row, s);
  tbody.append(row);
}

function appendSuiteRow(tbody: HTMLElement, suiteSessions: readonly DashboardSession[]): void {
  const [latest] = suiteSessions;
  if (latest === undefined) return;

  const label = suiteLabel(suiteSessions);
  const counts = aggregateSuiteCounts(suiteSessions);
  const score = aggregateSuiteScore(suiteSessions, counts);
  const durationMs = suiteSessions.reduce((sum, s) => sum + s.durationMs, 0);
  const expanderId = 'overview-suite-' + Math.random().toString(36).slice(2, 8);
  const arrow = el('span', { class: 'overview-suite-arrow', text: '▶' });

  const row = el('tr', {
    class: 'clickable overview-suite-summary-row',
    'data-suite-run-id': latest.suiteRunId ?? '',
    onclick: () => {
      const exp = document.querySelector<HTMLElement>('#' + expanderId);
      if (!exp) return;
      const isOpen = exp.classList.toggle('open');
      exp.style.display = isOpen ? 'table-row' : 'none';
      arrow.textContent = isOpen ? '▼' : '▶';
      row.classList.toggle('expanded', isOpen);
    },
  });
  const arrowCell = el('td', { class: 'overview-row-control' });
  arrowCell.append(arrow);
  row.append(arrowCell);
  row.append(
    el('td', {
      class: 'cell-nowrap',
      text: new Date(latest.startedAt).toLocaleString(),
      style: DIM_STYLE,
    }),
  );
  const runCell = el('td', {
    title: suiteSessions.length + (suiteSessions.length === 1 ? ' run' : ' runs'),
  });
  appendToolBadge(runCell, 'suite');
  row.append(runCell);
  row.append(el('td', { text: label, title: latest.suiteRunId ?? '', style: MUTED_STYLE }));
  row.append(el('td', { text: score + '%', style: 'font-weight:600;' + scoreColorStyle(score) }));
  const statusCell = el('td');
  statusCell.append(statusBadge(aggregateSuiteStatus(suiteSessions)));
  row.append(statusCell);
  row.append(el('td', { text: counts.passed + '/' + counts.total }));
  row.append(el('td', { text: '' + findingCount(counts) }));
  row.append(el('td', { text: (durationMs / 1000).toFixed(1) + 's', style: DIM_STYLE }));
  tbody.append(row);

  const expander = el('tr', { id: expanderId, class: 'expander-row overview-suite-expander-row' });
  const expanderCell = el('td', { colspan: '9', style: 'padding:0' });
  const expanderContent = el('div', { class: 'expander-content overview-suite-expander-content' });
  const childTable = el('table', { class: 'data-table overview-suite-child-table' });
  const childBody = el('tbody');
  suiteSessions.forEach((s) => {
    const childRow = el('tr', {
      class: 'clickable overview-suite-child-row',
      onclick: () => activateSession(s),
    });
    appendSessionCells(childRow, s, true);
    childBody.append(childRow);
  });
  childTable.append(childBody);
  expanderContent.append(childTable);
  expanderCell.append(expanderContent);
  expander.append(expanderCell);
  tbody.append(expander);
}

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
  const suiteRuns = groupSuiteSessionsByRunId(sessions);
  const renderedSuiteRunIds = new Set<string>();
  for (const session of sessions) {
    if (session.suiteRunId === undefined) {
      appendStandaloneRow(tbody, session);
      continue;
    }

    if (renderedSuiteRunIds.has(session.suiteRunId)) continue;
    renderedSuiteRunIds.add(session.suiteRunId);
    const suiteSessions = suiteRuns.get(session.suiteRunId) ?? [session];
    appendSuiteRow(tbody, suiteSessions);
  }
  table.append(tbody);
  const pag = el('div', { class: 'pagination' });
  pag.dataset.pageItemLabel = 'runs';
  sec.append(el('div', { class: 'card' }, [table, pag]));
  panel.append(sec);
  paginateGroupedRows(tbody, pag, 10);
}
