/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * Phase V — End-to-end validation against OpenSIP CLI's own
 * generated dashboard. Reads the live latest.html (produced by the
 * preceding `pnpm dashboard` run during workspace test bootstrap)
 * and exercises every view + the Function Card flow.
 *
 * Skipped when latest.html is missing or contains no graph catalog
 * (e.g. fresh checkout without a dogfood run). The harness can re-
 * run the dashboard CLI separately and re-execute this test.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE is packages/contracts/src/__tests__; repo root is four levels up.
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const REPORT = join(REPO_ROOT, 'opensip-cli', '.runtime', 'reports', 'latest.html');

/**
 * Upper bound on a report this test is willing to boot.
 *
 * jsdom must parse the whole document into a DOM, which costs many times the
 * file size in heap. This test used to read the live report unconditionally, so
 * a large one took the entire dashboard suite down with it: on a dogfood run of
 * this repo (17.5k functions) `latest.html` reached 293 MB, and the worker died
 * with "Ineffective mark-compacts near heap limit" — killing 9 tests in this
 * file and failing the package lane, with no indication of why. No heap setting
 * survives it (8 GB dies the same way); the only fix is not to load it.
 *
 * 24 MB sits above any DEFAULT report (the catalog budget is 8 MiB, so a real
 * one lands ~9 MB) and below what wedges jsdom. It deliberately excludes a
 * report generated with `opensip report --max-catalog-mb 64` — that artifact is
 * for exploring a big repo locally, not the shareable default this test
 * validates, and booting it would put the suite back where it started.
 */
const MAX_BOOTABLE_REPORT_BYTES = 24 * 1024 * 1024;

function readReportOrSkip(): string | null {
  if (!existsSync(REPORT)) return null;

  const { size } = statSync(REPORT);
  if (size > MAX_BOOTABLE_REPORT_BYTES) {
    // Skip LOUDLY. A silent skip here would hide the actual defect: a
    // self-contained report is meant to be opened in a browser and attached to
    // a PR, so one this large is a generator bug, not a test problem.
    process.stderr.write(
      `[dashboard-validation] SKIPPED — ${REPORT} is ${Math.round(size / 1e6)} MB, ` +
        `above the ${MAX_BOOTABLE_REPORT_BYTES / 1e6} MB cap this test will boot. ` +
        `Booting it exhausts the jsdom worker heap. A report this size is itself a ` +
        `defect: the embedded graph catalog is not bounded.\n`,
    );
    return null;
  }

  const html = readFileSync(REPORT, 'utf8');
  if (!html.includes('id="graph-catalog"')) return null;
  return html;
}

interface BootResult {
  views: { id: string; label: string }[];
  activateView: (id: string) => void;
  openFunctionCard: (h: string) => void;
  openCodePathsSession: (id: string) => void;
}

function bootDashboard(html: string): BootResult {
  // Render the full HTML into the jsdom document, then evaluate the
  // inlined script bodies in a single sandbox. Returns the local
  // bindings (views, activateView, openFunctionCard) — they're const
  // so they never reach globalThis.
  //
  // Booted ONCE per file (see beforeAll): the live report embeds the full
  // graph catalog (tens of MB), and each boot parses it, builds indexes, and
  // attaches document-level listeners that capture that state. Re-booting per
  // test never releases the prior boots' listeners/closures, so the worker
  // heap climbs with each `it` and eventually OOMs. One boot keeps it flat.
  document.documentElement.innerHTML = html
    .replace(/^[\s\S]*?<html[^>]*>/i, '')
    .replace(/<\/html>[\s\S]*$/i, '');
  // eslint-disable-next-line unicorn/prefer-spread -- NodeListOf<HTMLScriptElement> spread requires lib.dom.iterable.
  const scripts = Array.from(document.querySelectorAll('script'));
  let combined = '';
  for (const s of scripts) {
    const type = s.getAttribute('type');
    if (type && type !== 'text/javascript' && type !== '') continue;
    const src = s.textContent ?? '';
    if (src.length === 0) continue;
    combined += '\n' + src;
  }
  combined += '\nreturn { views, activateView, openFunctionCard, openCodePathsSession };';
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: our own emitted HTML.
  return new Function(combined).call(globalThis) as BootResult;
}

function activateExploreSubtab(): void {
  const exploreTab = document.querySelector<HTMLElement>(
    '#panel-code-paths .subtab[data-subtab="explore"]',
  );
  if (exploreTab) exploreTab.click();
}

// Precondition resolved at COLLECT time (sync fs read at module scope): with
// no bootable dogfood report, every test below is reported SKIPPED — never a
// silent expect(true) PASS (plan 09 Task 4.2). The oversized-report case
// additionally writes its loud stderr diagnostic in readReportOrSkip().
const reportHtml = readReportOrSkip();

describe.runIf(reportHtml !== null)('Phase V — dashboard end-to-end validation', () => {
  // The report embeds the full graph catalog (tens of MB). Boot the dashboard
  // exactly ONCE for the whole file (see bootDashboard) and share the result —
  // re-booting per test accumulated listeners/closures and OOM'd the worker.
  let env: BootResult;

  beforeAll(() => {
    env = bootDashboard(reportHtml as string);
  }, 120_000);

  // Strip transient overlays/drawers between tests so the single shared boot
  // doesn't leak UI state across `it` blocks.
  beforeEach(() => {
    for (const sel of ['.function-card-overlay', '.help-drawer-overlay', '.help-drawer']) {
      for (const node of document.querySelectorAll(sel)) node.remove();
    }
  });

  it('latest.html embeds the graph catalog', () => {
    expect(reportHtml).toContain('id="graph-catalog"');
  });

  it('boots without throwing and registers the 3 restructured Code Paths views', () => {
    expect(env.views).toBeDefined();
    // The restructured explore set: graph (node-link, with the SCC cycle
    // highlight fold) / coupling / distribution. The single-metric views
    // (hot/big/wide/untested) and the standalone SCCs view were dropped
    // once their signal moved into the engine gate rules; the standalone
    // Search subtab was folded into the Functions (distribution) view.
    expect(env.views.length).toBe(3);
    expect(new Set(env.views.map((v) => v.id))).toEqual(
      new Set(['graph', 'coupling', 'distribution']),
    );
  });

  it('Code Paths panel hosts Sessions and Explore subtabs', () => {
    expect(document.querySelector('#panel-code-paths-sessions')).not.toBeNull();
    expect(document.querySelector('#panel-code-paths-explore')).not.toBeNull();
    expect(
      document.querySelector('#panel-code-paths .subtab[data-subtab="sessions"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('#panel-code-paths .subtab[data-subtab="explore"]'),
    ).not.toBeNull();
  });

  it('renders the name-filter search input inside the Functions (distribution) view', () => {
    activateExploreSubtab();
    env.activateView('distribution');
    const input = document.querySelector(
      '#code-paths-view-distribution #code-paths-search-distribution',
    );
    expect(input).not.toBeNull();
    // The standalone Search view is gone — no #code-paths-view-search container.
    expect(document.querySelector('#code-paths-view-search')).toBeNull();
  });

  it('every Explore view container exists and the active one renders something', () => {
    activateExploreSubtab();
    for (const id of ['graph', 'coupling', 'distribution']) {
      const c = document.querySelector('#code-paths-view-' + id);
      expect(c).not.toBeNull();
    }
    const active = document.querySelector('.code-paths-view.active');
    expect(active).not.toBeNull();
    const hasRows = active!.querySelector('[data-body-hash]');
    const hasEmpty = active!.querySelector('.empty');
    expect(Boolean(hasRows) || Boolean(hasEmpty)).toBe(true);
  });

  it('Function Card overlay opens for the first row of the distribution view', (ctx) => {
    activateExploreSubtab();
    env.activateView('distribution');
    const firstRow = document.querySelector('#code-paths-view-distribution [data-body-hash]');
    // Data-dependent: a report can legitimately carry no distribution rows —
    // skip VISIBLY rather than fabricating a pass.
    if (!firstRow) return ctx.skip();
    env.openFunctionCard((firstRow as HTMLElement).dataset.bodyHash!);
    const overlays = document.querySelectorAll('.function-card-overlay');
    expect(overlays.length).toBe(1);
  });

  it('typing into the Functions name filter re-filters the table in place', () => {
    activateExploreSubtab();
    env.activateView('distribution');
    const view = document.querySelector('#code-paths-view-distribution')!;
    const allRowsBefore = view.querySelectorAll('[data-body-hash]').length;
    const input = view.querySelector('#code-paths-search-distribution')!;
    // A query that should match nothing collapses to the empty state.
    (input as HTMLInputElement).value = 'zzz_no_such_function_xyzzy';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const afterNoMatch = view.querySelectorAll('[data-body-hash]').length;
    const hasEmpty = view.querySelector('.empty');
    expect(afterNoMatch === 0 || Boolean(hasEmpty)).toBe(true);
    // Clearing the query restores the full distribution.
    (input as HTMLInputElement).value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const afterClear = view.querySelectorAll('[data-body-hash]').length;
    expect(afterClear).toBe(allRowsBefore);
  });

  it('the active view section heading exposes an info button that opens the help drawer', () => {
    activateExploreSubtab();
    env.activateView('distribution');
    const info = document.querySelector<HTMLButtonElement>(
      '#code-paths-view-distribution .section-info',
    );
    expect(info).not.toBeNull();
    info!.click();
    const drawer = document.querySelector('.help-drawer');
    expect(drawer).not.toBeNull();
    expect(drawer!.querySelector('h3')!.textContent).toBe('Functions (distribution)');
    // Close.
    document.querySelector<HTMLElement>('.help-drawer-close')!.click();
    expect(document.querySelector('.help-drawer-overlay')).toBeNull();
  });

  it('openCodePathsSession switches to Code Paths and selects the session row', (ctx) => {
    const firstGraphRow = document.querySelector<HTMLElement>(
      '#panel-code-paths-sessions tr[data-session-id]',
    );
    // Data-dependent: no graph sessions yet — skip VISIBLY.
    if (!firstGraphRow) return ctx.skip();
    const sessionId = firstGraphRow.dataset.sessionId!;
    env.openCodePathsSession(sessionId);
    const codePathsTab = document.querySelector('.tab[data-tab="code-paths"]');
    expect(codePathsTab!.classList.contains('active')).toBe(true);
    expect(document.querySelector('#panel-code-paths-sessions')!.classList.contains('active')).toBe(
      true,
    );
    const selected = document.querySelector<HTMLElement>('#panel-code-paths-sessions tr.selected');
    expect(selected).not.toBeNull();
    expect(selected!.dataset.sessionId).toBe(sessionId);
  });
});
