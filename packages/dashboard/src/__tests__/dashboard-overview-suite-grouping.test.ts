/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * Overview suite-grouping regressions — the synthetic `.suite-group-header`
 * divider rows the Overview table inserts between suite runs must NOT be treated
 * as sessions.
 *
 *   Fix #6 — pagination over-counted: `paginateTable` counted every
 *   `tbody.children` (dividers included), so the 'Showing X of M' total and the
 *   page window were inflated and < 10 sessions rendered per page. Overview now
 *   uses the header-aware `paginateSectionedRows`, which pages by SESSION-row
 *   count only and repeats a section's divider at the top of a continuation page.
 *
 *   Fix #7 — sorting scrambled the grouping: `collectRowGroups` treated each
 *   single-cell divider as a normal group; `compareGroups` read `children[colIdx]`
 *   (undefined for colIdx >= 1) and sorted them as '', clustering every banner at
 *   one end detached from its sessions. The sort entry point now drops
 *   `.suite-group-header` rows before collecting groups.
 *
 * Both exercise the FULL render path (generateDashboardHtml → boot the emitted
 * <script> in jsdom → renderOverview → paginateSectionedRows / makeSortable), so
 * the overview → paginator/sortable wiring is load-bearing, not mocked.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { generateDashboardHtml } from '../generator.js';

import type { StoredSession } from '@opensip-cli/contracts';

/** A suite-member fitness session (carries suiteRunId/suiteName → a divider row). */
function suiteSession(
  id: string,
  suiteRunId: string,
  suiteName: string,
  startedAt: string,
): StoredSession {
  return {
    id,
    tool: 'fit',
    startedAt,
    completedAt: startedAt,
    cwd: '/home/dev/project',
    suiteRunId,
    suiteName,
    score: 100,
    passed: true,
    runOutcome: 'passed',
    durationMs: 100,
    payload: {
      __version: 1,
      summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0 },
      checks: [],
    },
  };
}

/** Two contiguous suite runs of `n` sessions each → 2 dividers + 2n session rows. */
function twoSuites(n: number): StoredSession[] {
  const out: StoredSession[] = [];
  for (let i = 0; i < n; i++) {
    out.push(suiteSession('a' + i, 'suiteA', 'Audit', '2026-06-15T10:0' + i + ':00.000Z'));
  }
  for (let i = 0; i < n; i++) {
    out.push(suiteSession('b' + i, 'suiteB', 'Verify', '2026-06-15T11:0' + i + ':00.000Z'));
  }
  return out;
}

/**
 * Render the full report HTML into the jsdom document and evaluate its inlined
 * <script> bodies in one sandbox — the same boot the external-tab / end-to-end
 * validation tests use, so assertions run through the real render block
 * (`renderOverview(); …`) and the load-time sortable activation.
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

/** Session (clickable) rows only — excludes the `.suite-group-header` dividers. */
function sessionRows(): HTMLElement[] {
  return [...overviewTbody().querySelectorAll<HTMLElement>('tr.clickable')];
}

function dividerRows(): HTMLElement[] {
  return [...overviewTbody().querySelectorAll<HTMLElement>('tr.suite-group-header')];
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

describe('Overview pagination excludes suite-group-header rows (Fix #6)', () => {
  it('counts SESSION rows only in the page window and the "Showing X of M" total', () => {
    // 16 sessions across 2 suites → 18 DOM rows (16 clickable + 2 dividers).
    bootReport(twoSuites(8));

    expect(dividerRows()).toHaveLength(2);
    expect(sessionRows()).toHaveLength(16);

    // The total reflects sessions (16), NOT the 18 tbody children — page 1 shows
    // a full 10 sessions, not 10 mixed rows (which would strand 2 sessions).
    expect(paginationInfoText()).toBe('Showing 1-10 of 16');
    expect(visible(sessionRows())).toHaveLength(10);
  });

  it('repeats the continuation section divider and drops the finished one on the next page', () => {
    bootReport(twoSuites(8));

    // Page 1: both dividers visible (suite A fully, suite B starting).
    const [dividerA, dividerB] = dividerRows();
    expect(dividerA.style.display).not.toBe('none');
    expect(dividerB.style.display).not.toBe('none');

    clickPaginationButton('Next →');

    // Page 2: 6 remaining suite-B sessions; the total still counts sessions only.
    expect(paginationInfoText()).toBe('Showing 11-16 of 16');
    expect(visible(sessionRows())).toHaveLength(6);
    // Suite A's divider is gone (no visible A sessions); suite B's divider is
    // REPEATED at the top of the continuation page.
    expect(dividerA.style.display).toBe('none');
    expect(dividerB.style.display).not.toBe('none');
  });
});

describe('Overview sort drops suite-group-header banners (Fix #7)', () => {
  it('removes the divider rows on sort so banners never detach from their sessions', async () => {
    bootReport(twoSuites(8));
    await flushTimers(); // let the load-time sortable activation wire the <th> clicks

    expect(dividerRows()).toHaveLength(2);

    // Sort by the "Pass Rate" column (a non-first column dividers cannot supply).
    const th = [...document.querySelectorAll<HTMLElement>('#panel-overview thead th')].find(
      (h) => h.textContent === 'Pass Rate',
    )!;
    th.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    // Banners are gone entirely (honest behaviour: grouping is meaningless under
    // an arbitrary column sort; the per-row Suite column still carries membership).
    expect(dividerRows()).toHaveLength(0);
    // All 16 sessions survive the sort — none dropped, none stranded.
    expect(sessionRows()).toHaveLength(16);
    // No `.suite-group-header` left anywhere in the tbody to detach.
    expect(overviewTbody().querySelector('.suite-group-header')).toBeNull();
  });
});
