import { formatDuration, formatScore } from '@opensip-cli/format';

import { el } from './el.js';
import { scoreColorStyle, statusBadge } from './sessions.js';

const DIM_STYLE = 'color:var(--text-dim)';
const MUTED_STYLE = 'color:var(--text-muted)';
const EM_DASH = '—';
const EMPTY_SUMMARY = {
  total: 0,
  passed: 0,
  failed: 0,
  errors: 0,
  warnings: 0,
} as const;

type OverviewStatus = Parameters<typeof statusBadge>[0];

interface SummaryCounts {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly faulted: number;
  readonly errors: number;
  readonly warnings: number;
}

interface OverviewLedgerDeps {
  readonly appendToolBadge: (cell: HTMLElement, tool: string) => void;
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

function sessionCounts(session: DashboardSession): SummaryCounts {
  const summary = session.payload?.summary ?? EMPTY_SUMMARY;
  return {
    total: summary.total ?? 0,
    passed: summary.passed ?? 0,
    failed: summary.failed ?? 0,
    faulted: 0,
    errors: summary.errors ?? 0,
    warnings: summary.warnings ?? 0,
  };
}

function runStatus(run: DashboardRun): OverviewStatus {
  if (run.aggregate.faulted > 0) return 'error';
  if (run.aggregate.failed > 0 || run.exitCode !== 0) return 'fail';
  if (run.aggregate.warnings > 0) return 'warn';
  return 'pass';
}

function stepStatus(step: DashboardRunStep): OverviewStatus {
  if (step.outcome === 'faulted') return 'error';
  if (step.outcome === 'failed') return 'fail';
  return 'pass';
}

/**
 * Keep the Recipe column recipe-only. `effectiveArgs` is provenance and may
 * contain the entire resolved Commander option bag, so rendering it as a
 * fallback turns one cell into an unbounded command dump. A string recipe in
 * the ledger still helps faulted runs that never produced a session.
 */
function recipeCellLabel(step: DashboardRunStep, sessionRecipe?: string): string {
  if (sessionRecipe !== undefined) return sessionRecipe;
  const ledgerRecipe = step.effectiveArgs?.recipe;
  return typeof ledgerRecipe === 'string' && ledgerRecipe.length > 0 ? ledgerRecipe : EM_DASH;
}

function sortedSteps(run: DashboardRun): readonly DashboardRunStep[] {
  return [...run.steps].sort(
    (left, right) => left.ordinal - right.ordinal || left.attempt - right.attempt,
  );
}

function linkedSessionForStep(
  step: DashboardRunStep | undefined,
  sessionsById: ReadonlyMap<string, DashboardSession>,
): DashboardSession | undefined {
  return step?.sessionId === undefined ? undefined : sessionsById.get(step.sessionId);
}

function appendBlankControlCell(row: HTMLElement): void {
  row.append(el('td', { class: 'overview-row-control' }));
}

function appendTimestampCell(row: HTMLElement, iso: string | undefined): void {
  row.append(
    el('td', {
      class: 'cell-nowrap',
      text: iso === undefined ? '' : new Date(iso).toLocaleString(),
      style: DIM_STYLE,
    }),
  );
}

function appendStepRunCell(
  row: HTMLElement,
  step: DashboardRunStep,
  deps: OverviewLedgerDeps,
): void {
  const runCell = el('td', { title: step.command });
  deps.appendToolBadge(runCell, step.tool);
  if (step.command !== step.tool) {
    runCell.append(el('span', { text: step.command, style: 'margin-left:8px;' + MUTED_STYLE }));
  }
  row.append(runCell);
}

function appendLedgerStepCells(
  row: HTMLElement,
  step: DashboardRunStep,
  deps: OverviewLedgerDeps,
): void {
  appendBlankControlCell(row);
  appendTimestampCell(row, undefined);
  appendStepRunCell(row, step, deps);
  row.append(
    el('td', {
      text: recipeCellLabel(step),
      title: step.logicalStepKey,
      style: MUTED_STYLE,
    }),
  );
  row.append(el('td', { text: step.outcome, style: DIM_STYLE }));
  const statusCell = el('td');
  statusCell.append(statusBadge(stepStatus(step)));
  row.append(statusCell);
  row.append(el('td', { text: step.verdictSummary?.passed === true ? '1/1' : '0/1' }));
  row.append(el('td', { text: String(step.verdictSummary?.findings ?? 0) }));
  row.append(
    el('td', {
      text: formatDuration(step.durationMs),
      style: DIM_STYLE,
    }),
  );
}

function appendLinkedLedgerStepCells(
  row: HTMLElement,
  step: DashboardRunStep,
  session: DashboardSession,
  deps: OverviewLedgerDeps,
): void {
  const counts = sessionCounts(session);
  appendBlankControlCell(row);
  appendTimestampCell(row, session.startedAt);
  appendStepRunCell(row, step, deps);
  row.append(
    el('td', {
      text: recipeCellLabel(step, session.recipe),
      title: step.logicalStepKey,
      style: MUTED_STYLE,
    }),
  );
  row.append(
    el('td', {
      text: formatScore(session.score),
      style: 'font-weight:600;' + scoreColorStyle(session.score),
    }),
  );
  const statusCell = el('td');
  statusCell.append(statusBadge(stepStatus(step)));
  row.append(statusCell);
  row.append(el('td', { text: counts.passed + '/' + counts.total }));
  row.append(el('td', { text: String(findingCount(counts)) }));
  row.append(
    el('td', {
      text: formatDuration(step.durationMs),
      style: DIM_STYLE,
    }),
  );
}

function appendImplicitRunRow(
  tbody: HTMLElement,
  run: DashboardRun,
  sessionsById: ReadonlyMap<string, DashboardSession>,
  deps: OverviewLedgerDeps,
): void {
  const [step] = sortedSteps(run);
  const linked = linkedSessionForStep(step, sessionsById);
  const counts = linked === undefined ? runCounts(run) : sessionCounts(linked);
  const score = linked === undefined ? runScoreFromCounts(counts) : linked.score;
  const tool = step?.tool ?? linked?.tool ?? run.name;
  const label =
    step === undefined ? (linked?.recipe ?? EM_DASH) : recipeCellLabel(step, linked?.recipe);
  const row = el('tr', {
    class: linked === undefined ? 'overview-run-row' : 'clickable overview-run-row',
    ...(linked === undefined ? {} : { onclick: () => deps.activateSession(linked) }),
  });
  appendBlankControlCell(row);
  appendTimestampCell(row, run.startedAt);
  const runCell = el('td', { title: run.source });
  deps.appendToolBadge(runCell, tool);
  row.append(runCell);
  row.append(el('td', { text: label, title: run.id, style: MUTED_STYLE }));
  row.append(
    el('td', {
      text: formatScore(score),
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
      text: formatDuration(run.durationMs),
      style: DIM_STYLE,
    }),
  );
  tbody.append(row);
}

function runScoreFromCounts(counts: Pick<SummaryCounts, 'total' | 'passed'>): number {
  return counts.total > 0 ? Math.round((counts.passed / counts.total) * 100) : 0;
}

function appendLedgerRunRow(
  tbody: HTMLElement,
  run: DashboardRun,
  sessionsById: ReadonlyMap<string, DashboardSession>,
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
  runCell.append(el('span', { text: run.name, style: 'margin-left:8px;' + MUTED_STYLE }));
  row.append(runCell);
  row.append(el('td', { text: EM_DASH, title: run.id, style: MUTED_STYLE }));
  row.append(
    el('td', {
      text: formatScore(score),
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
      text: formatDuration(run.durationMs),
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
  sortedSteps(run).forEach((step) => {
    const linked = step.sessionId === undefined ? undefined : sessionsById.get(step.sessionId);
    const childRow = el('tr', {
      class:
        linked === undefined ? 'overview-suite-child-row' : 'clickable overview-suite-child-row',
      ...(linked === undefined ? {} : { onclick: () => deps.activateSession(linked) }),
    });
    if (linked) appendLinkedLedgerStepCells(childRow, step, linked, deps);
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
): void {
  const sessionsById = new Map(sourceSessions.map((session) => [session.id, session]));
  for (const run of sourceRuns) {
    if (run.source === 'implicit-tool') {
      appendImplicitRunRow(tbody, run, sessionsById, deps);
      continue;
    }
    appendLedgerRunRow(tbody, run, sessionsById, deps);
  }
}
