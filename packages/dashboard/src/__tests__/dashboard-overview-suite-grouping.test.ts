/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * Overview suite grouping regressions — suite runs render as one expandable
 * summary row in Recent Activity, with the child tool runs hidden behind the
 * disclosure arrow.
 *
 * These tests exercise the FULL render path (generateDashboardHtml → boot the
 * emitted <script> in jsdom → renderOverview → paginateGroupedRows /
 * makeSortable), so the overview, paginator, and sortable wiring is
 * load-bearing, not mocked.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { generateDashboardHtml } from '../generator.js';

import type { DashboardRun } from '../generator.js';
import type { StoredRunStep, StoredSession } from '@opensip-cli/contracts';

function makeSession(
  id: string,
  startedAt: string,
  overrides: Partial<StoredSession> = {},
): StoredSession {
  return {
    id,
    tool: 'fit',
    startedAt,
    completedAt: startedAt,
    cwd: '/home/dev/project',
    score: 100,
    passed: true,
    runOutcome: 'passed',
    durationMs: 100,
    payload: {
      __version: 1,
      summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0 },
      checks: [],
    },
    ...overrides,
  };
}

function suiteSession(
  id: string,
  suiteRunId: string,
  suiteName: string,
  startedAt: string,
  overrides: Partial<StoredSession> = {},
): StoredSession {
  return makeSession(id, startedAt, {
    suiteRunId,
    suiteName,
    ...overrides,
  });
}

function makeStep(overrides: Partial<StoredRunStep> = {}): StoredRunStep {
  return {
    id: 'step-1',
    runId: 'run-1',
    logicalStepKey: '1:fit:fit',
    ordinal: 1,
    attempt: 1,
    tool: 'fit',
    command: 'fit',
    stableId: 'fit',
    exitCode: 0,
    outcome: 'passed',
    durationMs: 100,
    verdictSummary: { passed: true, errors: 0, warnings: 0, findings: 0 },
    ...overrides,
  };
}

function makeRun(overrides: Partial<DashboardRun> = {}): DashboardRun {
  return {
    id: 'run-1',
    name: 'audit',
    source: 'built-in-suite',
    cwd: '/home/dev/project',
    startedAt: '2026-07-07T19:56:00.000Z',
    completedAt: '2026-07-07T19:56:30.000Z',
    durationMs: 30_000,
    exitCode: 0,
    aggregate: { steps: 1, passed: 1, failed: 0, faulted: 0, errors: 0, warnings: 0 },
    steps: [makeStep()],
    ...overrides,
  };
}

function implicitRunForSession(
  session: StoredSession,
  overrides: Partial<DashboardRun> = {},
): DashboardRun {
  const command = session.tool;
  return makeRun({
    id: 'run-' + session.id,
    name: command,
    source: 'implicit-tool',
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    durationMs: session.durationMs,
    exitCode: session.passed === false ? 1 : 0,
    aggregate: {
      steps: 1,
      passed: session.passed === false ? 0 : 1,
      failed: session.passed === false ? 1 : 0,
      faulted: 0,
      errors: summaryNumber(session, 'errors'),
      warnings: summaryNumber(session, 'warnings'),
    },
    steps: [
      makeStep({
        id: 'step-' + session.id,
        runId: 'run-' + session.id,
        logicalStepKey: '0:' + session.tool + ':' + command,
        ordinal: 0,
        tool: session.tool,
        command,
        stableId: session.tool,
        exitCode: session.passed === false ? 1 : 0,
        outcome: session.passed === false ? 'failed' : 'passed',
        durationMs: session.durationMs,
        verdictSummary: {
          passed: session.passed !== false,
          errors: summaryNumber(session, 'errors'),
          warnings: summaryNumber(session, 'warnings'),
          findings: summaryNumber(session, 'errors') + summaryNumber(session, 'warnings'),
        },
        sessionId: session.id,
      }),
    ],
    ...overrides,
  });
}

function summaryNumber(session: StoredSession, key: 'errors' | 'warnings'): number {
  const summary = (session.payload as { readonly summary?: Record<string, unknown> } | undefined)
    ?.summary;
  const value = summary?.[key];
  return typeof value === 'number' ? value : 0;
}

function auditSuite(): { readonly sessions: StoredSession[]; readonly runs: DashboardRun[] } {
  const sessions = [
    suiteSession('fit-1', 'suite-audit-1', 'audit', '2026-07-07T19:56:23.000Z', {
      tool: 'fit',
      recipe: 'agent-risk',
      score: 97,
      passed: false,
      runOutcome: 'failed',
      durationMs: 21_200,
      payload: {
        __version: 1,
        summary: { total: 127, passed: 123, failed: 4, errors: 53, warnings: 0 },
        checks: [],
      },
    }),
    suiteSession('graph-1', 'suite-audit-1', 'audit', '2026-07-07T19:56:35.000Z', {
      tool: 'graph',
      score: 100,
      durationMs: 1000,
      payload: {
        __version: 1,
        summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 1 },
        checks: [],
      },
    }),
    suiteSession('yagni-1', 'suite-audit-1', 'audit', '2026-07-07T19:56:46.000Z', {
      tool: 'yagni',
      score: 100,
      durationMs: 4000,
      payload: {
        __version: 1,
        summary: { total: 2, passed: 2, failed: 0, errors: 0, warnings: 0 },
        checks: [],
      },
    }),
  ];
  const run = makeRun({
    id: 'run-audit-1',
    name: 'audit',
    source: 'built-in-suite',
    startedAt: '2026-07-07T19:56:20.000Z',
    completedAt: '2026-07-07T19:56:49.200Z',
    durationMs: 29_200,
    exitCode: 1,
    aggregate: { steps: 3, passed: 2, failed: 1, faulted: 0, errors: 53, warnings: 1 },
    legacySuiteRunId: 'suite-audit-1',
    steps: [
      makeStep({
        id: 'step-fit',
        runId: 'run-audit-1',
        logicalStepKey: '1:fit:fit',
        ordinal: 1,
        tool: 'fit',
        command: 'fit',
        stableId: 'fit',
        exitCode: 1,
        outcome: 'failed',
        durationMs: 21_200,
        verdictSummary: { passed: false, errors: 53, warnings: 0, findings: 53 },
        sessionId: 'fit-1',
      }),
      makeStep({
        id: 'step-graph',
        runId: 'run-audit-1',
        logicalStepKey: '2:graph:impact',
        ordinal: 2,
        tool: 'graph',
        command: 'impact',
        stableId: 'graph',
        exitCode: 0,
        outcome: 'passed',
        durationMs: 1000,
        effectiveArgs: {
          args: [[]],
          cache: true,
          gateCompare: false,
          projectContext: { cwd: '/home/dev/project', walkedUp: 0 },
        },
        verdictSummary: { passed: true, errors: 0, warnings: 1, findings: 1 },
        sessionId: 'graph-1',
      }),
      makeStep({
        id: 'step-yagni',
        runId: 'run-audit-1',
        logicalStepKey: '3:yagni:yagni',
        ordinal: 3,
        tool: 'yagni',
        command: 'yagni',
        stableId: 'yagni',
        durationMs: 4000,
        effectiveArgs: {
          args: [[]],
          cloud: true,
          projectContext: { cwd: '/home/dev/project', walkedUp: 0 },
        },
        sessionId: 'yagni-1',
      }),
    ],
  });
  return { sessions, runs: [run] };
}

function manySuites(n: number): {
  readonly sessions: StoredSession[];
  readonly runs: DashboardRun[];
} {
  const sessions: StoredSession[] = [];
  const runs: DashboardRun[] = [];
  for (let i = 0; i < n; i++) {
    const minute = String(i).padStart(2, '0');
    const fitId = 'suite-' + i + '-fit';
    const graphId = 'suite-' + i + '-graph';
    sessions.push(
      suiteSession(fitId, 'suite-' + i, 'audit-' + i, '2026-07-07T19:' + minute + ':10.000Z'),
      suiteSession(graphId, 'suite-' + i, 'audit-' + i, '2026-07-07T19:' + minute + ':00.000Z', {
        tool: 'graph',
      }),
    );
    runs.push(
      makeRun({
        id: 'run-suite-' + i,
        name: 'audit-' + i,
        source: 'built-in-suite',
        startedAt: '2026-07-07T19:' + minute + ':00.000Z',
        completedAt: '2026-07-07T19:' + minute + ':11.000Z',
        durationMs: 11_000,
        aggregate: { steps: 2, passed: 2, failed: 0, faulted: 0, errors: 0, warnings: 0 },
        legacySuiteRunId: 'suite-' + i,
        steps: [
          makeStep({
            id: 'step-' + fitId,
            runId: 'run-suite-' + i,
            logicalStepKey: '1:fit:fit',
            ordinal: 1,
            sessionId: fitId,
          }),
          makeStep({
            id: 'step-' + graphId,
            runId: 'run-suite-' + i,
            logicalStepKey: '2:graph:graph',
            ordinal: 2,
            tool: 'graph',
            command: 'graph',
            stableId: 'graph',
            sessionId: graphId,
          }),
        ],
      }),
    );
  }
  return { sessions, runs };
}

/**
 * Render the full report HTML into the jsdom document and evaluate its inlined
 * <script> bodies in one sandbox — the same boot the external-tab / end-to-end
 * validation tests use.
 */
function bootReport(sessions: StoredSession[], runs: readonly DashboardRun[] = []): void {
  const html = generateDashboardHtml({ sessions, runs });
  document.documentElement.innerHTML = html
    .replace(/^[\s\S]*?<html[^>]*>/i, '')
    .replace(/<\/html>[\s\S]*$/i, '');
  // eslint-disable-next-line unicorn/prefer-spread -- NodeListOf spread needs lib.dom.iterable.
  const scripts = Array.from(document.querySelectorAll('script'));
  let combined = '';
  for (const s of scripts) {
    const type = s.getAttribute('type');
    if (type && type !== 'text/javascript' && type !== '') continue;
    const src = s.textContent ?? '';
    if (src.length === 0) continue;
    combined += '\n' + src;
  }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: our own emitted HTML.
  new Function(combined).call(globalThis);
}

/** Yield to the macrotask queue so the load-time `setTimeout(0)` sortable pass runs. */
function flushTimers(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function overviewTbody(): HTMLElement {
  return document.querySelector<HTMLElement>('#panel-overview tbody')!;
}

function overviewHeaders(): string[] {
  return [...document.querySelectorAll<HTMLElement>('#panel-overview thead th')].map(
    (h) => h.textContent ?? '',
  );
}

function topLevelRows(): HTMLElement[] {
  return [...overviewTbody().children] as HTMLElement[];
}

function suiteRows(): HTMLElement[] {
  return topLevelRows().filter((r) => r.classList.contains('overview-suite-summary-row'));
}

function childRows(): HTMLElement[] {
  return topLevelRows().filter((r) => r.classList.contains('overview-suite-child-row'));
}

function directRunRows(): HTMLElement[] {
  return topLevelRows().filter((r) => r.classList.contains('overview-run-row'));
}

function cells(row: HTMLElement): HTMLElement[] {
  return [...row.children] as HTMLElement[];
}

function visible(rows: HTMLElement[]): HTMLElement[] {
  return rows.filter((r) => r.style.display !== 'none');
}

function paginationInfoText(): string {
  return document.querySelector<HTMLElement>('#panel-overview .pagination-info')?.textContent ?? '';
}

function clickPaginationButton(text: string): void {
  const btn = [...document.querySelectorAll<HTMLElement>('#panel-overview .pagination-btn')].find(
    (b) => b.textContent === text,
  );
  if (!btn) throw new Error('no pagination button with text ' + JSON.stringify(text));
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.innerHTML = '';
});

describe('Overview suite rows', () => {
  it('renders one aggregate suite row and expands to show the child tool runs', () => {
    const { sessions, runs } = auditSuite();
    bootReport(sessions, runs);

    expect(suiteRows()).toHaveLength(1);
    expect(childRows()).toHaveLength(3);
    // Sibling rows in the same table (not a nested expander table).
    expect(topLevelRows()).toHaveLength(4);
    expect(suiteRows()[0].nextElementSibling?.classList.contains('overview-suite-child-row')).toBe(
      true,
    );

    const row = suiteRows()[0];
    const rowCells = cells(row);
    expect(overviewHeaders()).toEqual([
      '',
      'Timestamp',
      'Run',
      'Recipe',
      'Pass Rate',
      'Status',
      'Checks',
      'Findings',
      'Duration',
    ]);
    expect(rowCells).toHaveLength(9);
    expect(rowCells[2].querySelector('.badge')?.textContent).toBe('SUITE');
    expect(rowCells[2].textContent).toBe('SUITE');
    expect(rowCells[3].textContent).toBe('—');
    expect(row.textContent).toContain('67%');
    expect(row.textContent).toContain('FAIL');
    expect(row.textContent).toContain('2/3');
    expect(row.textContent).toContain('54');
    expect(row.textContent).toContain('29.2s');

    for (const child of childRows()) {
      expect(child.classList.contains('expander-row')).toBe(true);
      expect(child.classList.contains('open')).toBe(false);
      expect(cells(child)).toHaveLength(9);
    }
    expect(row.querySelector('.overview-suite-arrow')?.textContent).toBe('▶');

    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(row.classList.contains('expanded')).toBe(true);
    expect(row.querySelector('.overview-suite-arrow')?.textContent).toBe('▼');
    const [fitChild, graphChild, yagniChild] = childRows();
    expect(fitChild.classList.contains('open')).toBe(true);
    expect(fitChild.style.display).toBe('table-row');
    expect(cells(fitChild)[3].textContent).toBe('agent-risk');
    expect(cells(graphChild)[2].textContent).toBe('GRAPH');
    expect(cells(graphChild)[3].textContent).toBe('—');
    expect(cells(yagniChild)[3].textContent).toBe('—');
    expect(graphChild.textContent).not.toContain('projectContext');
    expect(yagniChild.textContent).not.toContain('projectContext');
  });

  it('renders only recipe metadata for linked and faulted implicit runs', () => {
    const graphSession = makeSession('standalone-graph', '2026-07-07T19:56:40.000Z', {
      tool: 'graph',
      recipe: undefined,
    });
    const linkedRun = implicitRunForSession(graphSession, {
      steps: [
        makeStep({
          id: 'step-standalone-graph',
          runId: 'run-standalone-graph',
          logicalStepKey: '0:graph:graph',
          ordinal: 0,
          tool: 'graph',
          command: 'graph',
          stableId: 'graph',
          effectiveArgs: {
            args: [[]],
            cache: true,
            gateCompare: false,
            projectContext: { cwd: '/home/dev/project', walkedUp: 0 },
          },
          sessionId: graphSession.id,
        }),
      ],
    });
    const faultedRun = makeRun({
      id: 'run-faulted-graph',
      name: 'graph',
      source: 'implicit-tool',
      exitCode: 2,
      aggregate: { steps: 1, passed: 0, failed: 0, faulted: 1, errors: 0, warnings: 0 },
      steps: [
        makeStep({
          id: 'step-faulted-graph',
          runId: 'run-faulted-graph',
          logicalStepKey: '0:graph:graph',
          ordinal: 0,
          tool: 'graph',
          command: 'graph',
          stableId: 'graph',
          effectiveArgs: {
            recipe: 'agent-risk',
            cache: true,
            projectContext: { cwd: '/home/dev/project', walkedUp: 0 },
          },
          exitCode: 2,
          outcome: 'faulted',
          verdictSummary: undefined,
        }),
      ],
    });

    bootReport([graphSession], [linkedRun, faultedRun]);

    const [linkedRow, faultedRow] = directRunRows();
    expect(cells(linkedRow)[3].textContent).toBe('—');
    expect(cells(faultedRow)[3].textContent).toBe('agent-risk');
    expect(linkedRow.textContent).not.toContain('projectContext');
    expect(faultedRow.textContent).not.toContain('projectContext');
  });

  it('does not reconstruct overview rows from sessions without ledger runs', () => {
    const { sessions } = auditSuite();
    bootReport(sessions);

    expect(document.querySelector('#panel-overview table')).toBeNull();
    expect(document.querySelector('#panel-overview')?.textContent).toContain('No runs yet.');
  });

  it('shows suite ledger duration for linked suite child rows', () => {
    const graphSession = suiteSession(
      'graph-session',
      'suite-ledger-1',
      'audit',
      '2026-07-07T19:56:30.000Z',
      {
        tool: 'graph',
        durationMs: 592,
      },
    );
    const run: DashboardRun = {
      id: 'run-ledger-1',
      name: 'audit',
      source: 'built-in-suite',
      cwd: '/home/dev/project',
      startedAt: '2026-07-07T19:56:00.000Z',
      completedAt: '2026-07-07T19:56:02.000Z',
      durationMs: 2000,
      exitCode: 0,
      aggregate: { steps: 1, passed: 1, failed: 0, faulted: 0, errors: 0, warnings: 1 },
      legacySuiteRunId: 'suite-ledger-1',
      steps: [
        {
          id: 'step-graph',
          runId: 'run-ledger-1',
          logicalStepKey: '1:graph:impact',
          ordinal: 1,
          attempt: 1,
          tool: 'graph',
          command: 'impact',
          stableId: 'graph',
          exitCode: 0,
          outcome: 'passed',
          durationMs: 1058,
          verdictSummary: { passed: true, errors: 0, warnings: 1, findings: 1 },
          sessionId: 'graph-session',
        },
      ],
    };
    bootReport([graphSession], [run]);

    const row = suiteRows()[0];
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const child = childRows()[0];
    expect(cells(child)[1].textContent).not.toBe('');
    expect(child.textContent).toContain('1.1s');
    expect(child.textContent).not.toContain('592ms');
  });

  it('groups suite children by run id even when another run is interleaved', () => {
    const suiteFit = suiteSession(
      'suite-a-fit',
      'suite-audit-1',
      'audit',
      '2026-07-07T19:56:46.000Z',
    );
    const standaloneGraph = makeSession('standalone-graph', '2026-07-07T19:56:40.000Z', {
      tool: 'graph',
    });
    const suiteYagni = suiteSession(
      'suite-a-yagni',
      'suite-audit-1',
      'audit',
      '2026-07-07T19:56:23.000Z',
      {
        tool: 'yagni',
      },
    );
    const suiteRun = makeRun({
      id: 'run-suite-audit-1',
      name: 'audit',
      source: 'built-in-suite',
      legacySuiteRunId: 'suite-audit-1',
      aggregate: { steps: 2, passed: 2, failed: 0, faulted: 0, errors: 0, warnings: 0 },
      steps: [
        makeStep({ id: 'step-suite-a-fit', runId: 'run-suite-audit-1', sessionId: suiteFit.id }),
        makeStep({
          id: 'step-suite-a-yagni',
          runId: 'run-suite-audit-1',
          logicalStepKey: '2:yagni:yagni',
          ordinal: 2,
          tool: 'yagni',
          command: 'yagni',
          stableId: 'yagni',
          sessionId: suiteYagni.id,
        }),
      ],
    });
    bootReport(
      [suiteFit, standaloneGraph, suiteYagni],
      [suiteRun, implicitRunForSession(standaloneGraph)],
    );

    expect(suiteRows()).toHaveLength(1);
    expect(childRows()).toHaveLength(2);
    expect(directRunRows()).toHaveLength(1);
    // suite summary + 2 sibling step rows + 1 standalone run
    expect(topLevelRows()).toHaveLength(4);
    expect(suiteRows()[0].nextElementSibling?.classList.contains('overview-suite-child-row')).toBe(
      true,
    );
    expect(cells(suiteRows()[0])[2].getAttribute('title')).toBe('built-in-suite');
  });

  it('paginates by suite or standalone run rows, not by hidden child runs', () => {
    const { sessions, runs } = manySuites(12);
    bootReport(sessions, runs);

    expect(suiteRows()).toHaveLength(12);
    expect(childRows()).toHaveLength(24);
    expect(paginationInfoText()).toBe('Showing 1-10 of 12 runs');
    expect(visible(suiteRows())).toHaveLength(10);

    clickPaginationButton('Next →');

    expect(paginationInfoText()).toBe('Showing 11-12 of 12 runs');
    expect(visible(suiteRows())).toHaveLength(2);
  });

  it('keeps each suite step group attached to its summary row after sorting', async () => {
    const audit = auditSuite();
    const many = manySuites(2);
    bootReport([...audit.sessions, ...many.sessions], [...audit.runs, ...many.runs]);
    await flushTimers();

    const th = [...document.querySelectorAll<HTMLElement>('#panel-overview thead th')].find(
      (h) => h.textContent === 'Pass Rate',
    )!;
    th.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(document.querySelector('.suite-group-header')).toBeNull();
    for (const row of suiteRows()) {
      let sibling = row.nextElementSibling as HTMLElement | null;
      expect(sibling?.classList.contains('overview-suite-child-row')).toBe(true);
      // All consecutive child rows stay glued; next non-child is another top-level run.
      while (sibling?.classList.contains('overview-suite-child-row') === true) {
        sibling = sibling.nextElementSibling as HTMLElement | null;
      }
      if (sibling !== null) {
        expect(sibling.classList.contains('overview-suite-child-row')).toBe(false);
      }
    }
  });
});
