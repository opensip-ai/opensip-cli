import { el } from './el.js';
import { scoreColorStyle, statusBadge } from './sessions.js';

const DIM_STYLE = 'color:var(--text-dim)';
const MUTED_STYLE = 'color:var(--text-muted)';

type OverviewStatus = Parameters<typeof statusBadge>[0];

interface SummaryCounts {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly faulted: number;
  readonly errors: number;
  readonly warnings: number;
}

export interface LedgerRenderedRows {
  readonly suiteRunIds: ReadonlySet<string>;
  readonly sessionIds: ReadonlySet<string>;
}

interface OverviewLedgerDeps {
  readonly appendToolBadge: (cell: HTMLElement, tool: string) => void;
  readonly appendSessionCells: (
    row: HTMLElement,
    session: DashboardSession,
    child: boolean,
  ) => void;
  readonly activateSession: (session: DashboardSession) => void;
}

function findingCount(counts: Pick<SummaryCounts, 'errors' | 'warnings'>): number {
  return counts.errors + counts.warnings;
}

function runCounts(run: DashboardRun): SummaryCounts {
  return {
    total: run.aggregate.steps,
    passed: run.aggregate.passed,
    failed: run.aggregate.failed,
    faulted: run.aggregate.faulted,
    errors: run.aggregate.errors,
    warnings: run.aggregate.warnings,
  };
}

function runStatus(run: DashboardRun): OverviewStatus {
  if (run.aggregate.faulted > 0) return 'error';
  if (run.aggregate.failed > 0 || run.exitCode !== 0) return 'fail';
  if (run.aggregate.warnings > 0) return 'warn';
  return 'pass';
}

function stepLabel(step: DashboardRunStep): string {
  const args = step.effectiveArgs;
  if (args === undefined || Object.keys(args).length === 0) return step.command;
  const rendered = Object.entries(args)
    .map(([key, value]) => `${key}=${formatStepArgValue(value)}`)
    .join(' ');
  return `${step.command} ${rendered}`;
}

function formatStepArgValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol')
    return value.description === undefined ? 'Symbol()' : `Symbol(${value.description})`;
  try {
    return JSON.stringify(value) ?? '[unserializable]';
  } catch {
    return '[unserializable]';
  }
}

function appendLedgerStepCells(
  row: HTMLElement,
  step: DashboardRunStep,
  deps: OverviewLedgerDeps,
): void {
  row.append(el('td', { text: '' }));
  row.append(el('td', { text: '', style: DIM_STYLE }));
  const runCell = el('td');
  deps.appendToolBadge(runCell, step.tool);
  row.append(runCell);
  row.append(
    el('td', {
      text: stepLabel(step),
      title: step.logicalStepKey,
      style: MUTED_STYLE,
    }),
  );
  row.append(el('td', { text: step.outcome, style: DIM_STYLE }));
  const statusCell = el('td');
  statusCell.append(statusBadge(ledgerStepStatus(step)));
  row.append(statusCell);
  row.append(el('td', { text: step.verdictSummary?.passed === true ? '1/1' : '0/1' }));
  row.append(el('td', { text: String(step.verdictSummary?.findings ?? 0) }));
  row.append(
    el('td', {
      text: (step.durationMs / 1000).toFixed(1) + 's',
      style: DIM_STYLE,
    }),
  );
}

function ledgerStepStatus(step: DashboardRunStep): OverviewStatus {
  if (step.outcome === 'faulted') return 'error';
  if (step.outcome === 'failed') return 'fail';
  return 'pass';
}

function appendLedgerRunRow(
  tbody: HTMLElement,
  run: DashboardRun,
  sourceSessions: readonly DashboardSession[],
  deps: OverviewLedgerDeps,
): void {
  const counts = runCounts(run);
  const score = counts.total > 0 ? Math.round((counts.passed / counts.total) * 100) : 0;
  const expanderId = 'overview-run-' + Math.random().toString(36).slice(2, 8);
  const arrow = el('span', { class: 'overview-suite-arrow', text: '▶' });
  const row = el('tr', {
    class: 'clickable overview-suite-summary-row',
    'data-suite-run-id': run.legacySuiteRunId ?? run.id,
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
      text: new Date(run.startedAt).toLocaleString(),
      style: DIM_STYLE,
    }),
  );
  const runCell = el('td', { title: run.source });
  deps.appendToolBadge(runCell, 'suite');
  row.append(runCell);
  row.append(el('td', { text: run.name, title: run.id, style: MUTED_STYLE }));
  row.append(
    el('td', {
      text: score + '%',
      style: 'font-weight:600;' + scoreColorStyle(score),
    }),
  );
  const statusCell = el('td');
  statusCell.append(statusBadge(runStatus(run)));
  row.append(statusCell);
  row.append(el('td', { text: counts.passed + '/' + counts.total }));
  row.append(el('td', { text: '' + findingCount(counts) }));
  row.append(
    el('td', {
      text: (run.durationMs / 1000).toFixed(1) + 's',
      style: DIM_STYLE,
    }),
  );
  tbody.append(row);

  const expander = el('tr', {
    id: expanderId,
    class: 'expander-row overview-suite-expander-row',
  });
  const expanderCell = el('td', { colspan: '9', style: 'padding:0' });
  const expanderContent = el('div', {
    class: 'expander-content overview-suite-expander-content',
  });
  const childTable = el('table', {
    class: 'data-table overview-suite-child-table',
  });
  const childBody = el('tbody');
  const sessionsById = new Map(sourceSessions.map((session) => [session.id, session]));
  [...run.steps]
    .sort((left, right) => left.ordinal - right.ordinal || left.attempt - right.attempt)
    .forEach((step) => {
      const linked = step.sessionId === undefined ? undefined : sessionsById.get(step.sessionId);
      const childRow = el('tr', {
        class:
          linked === undefined ? 'overview-suite-child-row' : 'clickable overview-suite-child-row',
        ...(linked === undefined ? {} : { onclick: () => deps.activateSession(linked) }),
      });
      if (linked) deps.appendSessionCells(childRow, linked, true);
      else appendLedgerStepCells(childRow, step, deps);
      childBody.append(childRow);
    });
  childTable.append(childBody);
  expanderContent.append(childTable);
  expanderCell.append(expanderContent);
  expander.append(expanderCell);
  tbody.append(expander);
}

export function appendLedgerRows(
  tbody: HTMLElement,
  sourceRuns: readonly DashboardRun[],
  sourceSessions: readonly DashboardSession[],
  deps: OverviewLedgerDeps,
): LedgerRenderedRows {
  const suiteRunIds = new Set<string>();
  const sessionIds = new Set<string>();
  for (const run of sourceRuns.filter((candidate) => candidate.source !== 'implicit-tool')) {
    appendLedgerRunRow(tbody, run, sourceSessions, deps);
    if (run.legacySuiteRunId !== undefined) suiteRunIds.add(run.legacySuiteRunId);
    for (const step of run.steps) {
      if (step.sessionId !== undefined) sessionIds.add(step.sessionId);
    }
  }
  return { suiteRunIds, sessionIds };
}
