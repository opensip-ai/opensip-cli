/**
 * Session table rendering — used by the fitness/sim/graph tabs.
 *
 * `renderSessionTable(panel, toolSessions, accentColor)` renders the per-tool
 * session list and wires each row to the expandable detail panel (the detail
 * rendering itself lives in session-detail.ts). `statusBadge` / `sessionStatus` /
 * `scoreColorStyle` are also consumed by the Overview tab (overview.ts imports
 * them directly).
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 * `renderSessionTable` stays exposed as a page global because the still-string-
 * emitted Code Paths panel calls it by bare name.
 */

import { el } from './el.js';
import { paginateTable } from './pagination.js';
import { renderSessionDetail } from './session-detail.js';

// Shared dim-text inline style.
const DIM = 'color:var(--text-dim)';

/** Inline color style for a 0-100 pass-rate score (success / warning / error bands). */
export function scoreColorStyle(score: number): string {
  if (score >= 90) return 'color:var(--success)';
  if (score >= 70) return 'color:var(--warning)';
  return 'color:var(--error)';
}

/** Empty per-session summary used when a tool persists no summary payload. */
const EMPTY_SUMMARY = { total: 0, passed: 0, failed: 0, errors: 0, warnings: 0 } as const;

type SessionStatus = 'fail' | 'warn' | 'pass' | 'error' | 'degraded';

/** Legacy rows without runOutcome: infer passed/failed only — never degraded/error. */
function legacyRunOutcome(s: DashboardSession): 'passed' | 'failed' {
  return s.passed === false ? 'failed' : 'passed';
}

/** Resolve persisted outcome; legacy rows infer passed/failed only. */
export function resolvedRunOutcome(s: DashboardSession): SessionStatus {
  const stored = s.runOutcome ?? legacyRunOutcome(s);
  if (stored === 'error') return 'error';
  if (stored === 'degraded') return 'degraded';
  if (stored === 'failed') return 'fail';
  if (stored === 'passed') return 'pass';
  const sm = s.payload?.summary ?? {};
  if ((sm.failed ?? 0) > 0) return 'fail';
  if ((sm.warnings ?? 0) > 0) return 'warn';
  return 'pass';
}

/**
 * Derive session status for badges. Prefers persisted {@link runOutcome}; falls
 * back to legacy passed + payload summary counts.
 */
export function sessionStatus(s: DashboardSession): SessionStatus {
  return resolvedRunOutcome(s);
}

export function statusBadge(status: SessionStatus): HTMLElement {
  const labels: Record<SessionStatus, string> = {
    fail: 'FAIL',
    warn: 'WARN',
    pass: 'PASS',
    error: 'ERROR',
    degraded: 'DEGRADED',
  };
  const classes: Record<SessionStatus, string> = {
    fail: 'badge-fail',
    warn: 'badge-warn',
    pass: 'badge-pass',
    error: 'badge-fail',
    degraded: 'badge-warn',
  };
  return el('span', { class: 'badge ' + classes[status], text: labels[status] });
}

/** Score cell style — error/degraded runs must not show green 100%. */
export function sessionScoreStyle(s: DashboardSession): string {
  const outcome = resolvedRunOutcome(s);
  if (outcome === 'error') return 'color:var(--error)';
  if (outcome === 'degraded') return 'color:var(--warning)';
  return scoreColorStyle(s.score);
}

/** Build the session table's header row. */
function buildSessionHead(): HTMLElement {
  const thead = el('thead');
  const headerRow = el('tr');
  [
    'Timestamp',
    'Recipe',
    'Pass Rate',
    'Status',
    'Passed',
    'Failed',
    'Findings',
    'Duration',
  ].forEach((h) => {
    headerRow.append(el('th', { text: h }));
  });
  thead.append(headerRow);
  return thead;
}

export function renderSessionTable(
  panel: HTMLElement,
  toolSessions: readonly DashboardSession[],
  _accentColor: string,
): void {
  if (toolSessions.length === 0) {
    panel.append(el('div', { class: 'empty', text: 'No sessions yet.' }));
    return;
  }

  const tool = toolSessions[0].tool;

  const table = el('table', { class: 'data-table sortable' });
  table.append(buildSessionHead());

  // Detail container — kept as a direct reference, no global ID lookup needed.
  const detailContainer = el('div', {
    id: 'detail-' + tool + '-' + Math.random().toString(36).slice(2, 8),
    class: 'section',
    style: 'display:none',
  });

  const tbody = el('tbody');
  toolSessions.forEach((s, idx) => {
    const sc = sessionScoreStyle(s);
    const sm = s.payload?.summary ?? EMPTY_SUMMARY;
    const row = el('tr', {
      class: 'clickable',
      id: 'session-row-' + tool + '-' + idx,
      'data-session-id': s.id,
      onclick: () => {
        tbody.querySelectorAll('tr.selected').forEach((r) => r.classList.remove('selected'));
        row.classList.add('selected');
        renderSessionDetail(detailContainer, s, idx, tool);
      },
    });
    row.append(el('td', { class: 'cell-nowrap', text: new Date(s.startedAt).toLocaleString() }));
    row.append(el('td', { text: s.recipe ?? 'default', style: 'color:var(--text-muted)' }));
    const scoreCell = el('td', { style: 'font-weight:600;' + sc });
    scoreCell.textContent = s.score + '%';
    row.append(scoreCell);
    const badgeCell = el('td');
    badgeCell.append(statusBadge(sessionStatus(s)));
    row.append(badgeCell);
    row.append(el('td', { text: '' + (sm.passed ?? 0), style: 'color:var(--success)' }));
    row.append(
      el('td', {
        text: '' + (sm.failed ?? 0),
        style: (sm.failed ?? 0) > 0 ? 'color:var(--error)' : DIM,
      }),
    );
    row.append(el('td', { text: '' + ((sm.errors ?? 0) + (sm.warnings ?? 0)) }));
    row.append(el('td', { text: (s.durationMs / 1000).toFixed(1) + 's', style: DIM }));
    tbody.append(row);
  });
  table.append(tbody);

  const sessionPag = el('div', { class: 'pagination' });
  const sec = el('div', { class: 'section' }, [
    el('h3', { text: 'Sessions (' + toolSessions.length + ')' }),
    el('div', { class: 'card' }, [table, sessionPag]),
  ]);
  panel.append(sec);
  paginateTable(tbody, sessionPag, 10);

  panel.append(detailContainer);

  // Auto-show latest and highlight first row.
  renderSessionDetail(detailContainer, toolSessions[0], 0, tool);
  const firstRow = tbody.querySelector('tr');
  if (firstRow) firstRow.classList.add('selected');
}
