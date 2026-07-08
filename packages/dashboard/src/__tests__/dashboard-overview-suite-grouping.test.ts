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

import type { StoredSession } from '@opensip-cli/contracts';

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

function auditSuite(): StoredSession[] {
  return [
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
    suiteSession('yagni-2', 'suite-audit-1', 'audit', '2026-07-07T19:56:46.000Z', {
      tool: 'yagni',
      score: 100,
      durationMs: 4000,
      payload: {
        __version: 1,
        summary: { total: 2, passed: 2, failed: 0, errors: 0, warnings: 0 },
        checks: [],
      },
    }),
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
  ];
}

function manySuites(n: number): StoredSession[] {
  const out: StoredSession[] = [];
  for (let i = 0; i < n; i++) {
    const minute = String(i).padStart(2, '0');
    out.push(
      suiteSession(
        'suite-' + i + '-fit',
        'suite-' + i,
        'audit-' + i,
        '2026-07-07T19:' + minute + ':10.000Z',
      ),
      suiteSession(
        'suite-' + i + '-graph',
        'suite-' + i,
        'audit-' + i,
        '2026-07-07T19:' + minute + ':00.000Z',
        {
          tool: 'graph',
        },
      ),
    );
  }
  return out;
}

/**
 * Render the full report HTML into the jsdom document and evaluate its inlined
 * <script> bodies in one sandbox — the same boot the external-tab / end-to-end
 * validation tests use.
 */
function bootReport(sessions: StoredSession[]): void {
  const html = generateDashboardHtml({ sessions });
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

function expanderRows(): HTMLElement[] {
  return topLevelRows().filter((r) => r.classList.contains('overview-suite-expander-row'));
}

function childRows(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('#panel-overview .overview-suite-child-row')];
}

function standaloneRows(): HTMLElement[] {
  return topLevelRows().filter((r) => r.classList.contains('overview-session-row'));
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
    bootReport(auditSuite());

    expect(suiteRows()).toHaveLength(1);
    expect(expanderRows()).toHaveLength(1);
    expect(childRows()).toHaveLength(3);

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
    expect(rowCells[3].textContent).toBe('audit');
    expect(row.textContent).toContain('97%');
    expect(row.textContent).toContain('FAIL');
    expect(row.textContent).toContain('127/131');
    expect(row.textContent).toContain('53');
    expect(row.textContent).toContain('29.2s');

    const expander = expanderRows()[0];
    expect(expander.classList.contains('open')).toBe(false);
    expect(row.querySelector('.overview-suite-arrow')?.textContent).toBe('▶');

    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(expander.classList.contains('open')).toBe(true);
    expect(expander.style.display).toBe('table-row');
    expect(row.querySelector('.overview-suite-arrow')?.textContent).toBe('▼');
    expect(
      childRows()
        .map((r) => r.textContent ?? '')
        .join('\n'),
    ).toContain('agent-risk');
  });

  it('groups suite children by run id even when another run is interleaved', () => {
    bootReport([
      suiteSession('suite-a-fit', 'suite-audit-1', 'audit', '2026-07-07T19:56:46.000Z'),
      makeSession('standalone-graph', '2026-07-07T19:56:40.000Z', { tool: 'graph' }),
      suiteSession('suite-a-yagni', 'suite-audit-1', 'audit', '2026-07-07T19:56:23.000Z', {
        tool: 'yagni',
      }),
    ]);

    expect(suiteRows()).toHaveLength(1);
    expect(expanderRows()).toHaveLength(1);
    expect(childRows()).toHaveLength(2);
    expect(standaloneRows()).toHaveLength(1);
    expect(topLevelRows()).toHaveLength(3);
    expect(
      suiteRows()[0].nextElementSibling?.classList.contains('overview-suite-expander-row'),
    ).toBe(true);
    expect(cells(suiteRows()[0])[2].getAttribute('title')).toBe('2 runs');
  });

  it('paginates by suite or standalone run rows, not by hidden child runs', () => {
    bootReport(manySuites(12));

    expect(suiteRows()).toHaveLength(12);
    expect(childRows()).toHaveLength(24);
    expect(paginationInfoText()).toBe('Showing 1-10 of 12 runs');
    expect(visible(suiteRows())).toHaveLength(10);

    clickPaginationButton('Next →');

    expect(paginationInfoText()).toBe('Showing 11-12 of 12 runs');
    expect(visible(suiteRows())).toHaveLength(2);
  });

  it('keeps each suite expander attached to its summary row after sorting', async () => {
    bootReport([...auditSuite(), ...manySuites(2)]);
    await flushTimers();

    const th = [...document.querySelectorAll<HTMLElement>('#panel-overview thead th')].find(
      (h) => h.textContent === 'Pass Rate',
    )!;
    th.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(document.querySelector('.suite-group-header')).toBeNull();
    for (const row of suiteRows()) {
      expect(row.nextElementSibling?.classList.contains('overview-suite-expander-row')).toBe(true);
    }
  });
});
