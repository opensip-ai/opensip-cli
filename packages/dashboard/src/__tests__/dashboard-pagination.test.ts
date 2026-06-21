/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * Pagination interaction tests — proves the event-delegation rewrite preserves
 * the click behaviour after the graph:cycle break.
 *
 * The page buttons are now PURE (each carries `data-page-target`; no per-button
 * onclick closure); navigation flows through ONE delegated listener attached to
 * the pagination container. These tests boot the client bundle and drive
 * `paginateTable` (global) and `renderChecksCatalog` (global) by clicking real
 * buttons, asserting the visible page changes — including the re-pagination case
 * (the checks catalog re-paginates the SAME container as filters toggle).
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { DASHBOARD_CLIENT_BUNDLE } from '../client-bundle.generated.js';

type PaginateFn = (tbody: HTMLElement, pag: HTMLElement, pageSize: number) => void;
type RenderChecksFn = (container: HTMLElement, data: readonly unknown[]) => void;

/** A check catalog entry used to build the renderChecksCatalog fixture. */
interface CatalogEntry {
  slug: string;
  name: string;
  source: string;
  confidence: string;
  tags: string[];
}

/** Build `n` catalog entries with sortable, search-matchable slugs. */
function buildCatalog(n: number): CatalogEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    slug: 'check-' + String(i).padStart(2, '0'),
    name: 'Check ' + i,
    source: 'universal',
    confidence: 'high',
    tags: ['quality'],
  }));
}

function bundleGlobals(): { paginateTable: PaginateFn; renderChecksCatalog: RenderChecksFn } {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: our own bundled dashboard JS.
  return new Function(
    'var sessions = [];\n' +
      DASHBOARD_CLIENT_BUNDLE +
      '\nreturn { paginateTable, renderChecksCatalog };',
  )() as { paginateTable: PaginateFn; renderChecksCatalog: RenderChecksFn };
}

/** Build a tbody with `n` single-cell data rows whose text is the row index. */
function buildRows(n: number): { table: HTMLElement; tbody: HTMLElement } {
  const table = document.createElement('table');
  const tbody = document.createElement('tbody');
  for (let i = 0; i < n; i++) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.textContent = 'row-' + i;
    tr.append(td);
    tbody.append(tr);
  }
  table.append(tbody);
  return { table, tbody };
}

/** The indices of currently-visible data rows (display !== 'none'). */
function visibleRowIndexes(tbody: HTMLElement): number[] {
  const out: number[] = [];
  [...tbody.children].forEach((row, i) => {
    if ((row as HTMLElement).style.display !== 'none') out.push(i);
  });
  return out;
}

function clickButtonWithText(pag: HTMLElement, text: string): void {
  const btn = [...pag.querySelectorAll<HTMLElement>('.pagination-btn')].find(
    (b) => b.textContent === text,
  );
  if (!btn) throw new Error('no pagination button with text ' + JSON.stringify(text));
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('paginateTable interaction', () => {
  it('shows the first 10 of 25 rows initially with page buttons', () => {
    const { paginateTable } = bundleGlobals();
    const { tbody } = buildRows(25);
    const pag = document.createElement('div');
    paginateTable(tbody, pag, 10);
    expect(visibleRowIndexes(tbody)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(pag.querySelectorAll('.pagination-btn').length).toBeGreaterThan(0);
  });

  it('clicking Next advances to the second page', () => {
    const { paginateTable } = bundleGlobals();
    const { tbody } = buildRows(25);
    const pag = document.createElement('div');
    paginateTable(tbody, pag, 10);
    clickButtonWithText(pag, 'Next →');
    expect(visibleRowIndexes(tbody)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  it('clicking a numbered button jumps to that page', () => {
    const { paginateTable } = bundleGlobals();
    const { tbody } = buildRows(25);
    const pag = document.createElement('div');
    paginateTable(tbody, pag, 10);
    clickButtonWithText(pag, '3'); // page index 2 → rows 20..24
    expect(visibleRowIndexes(tbody)).toEqual([20, 21, 22, 23, 24]);
  });

  it('clicking Next then Prev returns to the first page', () => {
    const { paginateTable } = bundleGlobals();
    const { tbody } = buildRows(25);
    const pag = document.createElement('div');
    paginateTable(tbody, pag, 10);
    clickButtonWithText(pag, 'Next →');
    clickButtonWithText(pag, '← Prev');
    expect(visibleRowIndexes(tbody)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('disabled Prev on the first page is a no-op', () => {
    const { paginateTable } = bundleGlobals();
    const { tbody } = buildRows(25);
    const pag = document.createElement('div');
    paginateTable(tbody, pag, 10);
    clickButtonWithText(pag, '← Prev'); // disabled on page 0
    expect(visibleRowIndexes(tbody)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe('checks catalog re-pagination (delegated listener survives data swap)', () => {
  it('paginates, then re-paginates the filtered subset on the SAME container, and clicks still work', () => {
    const { renderChecksCatalog } = bundleGlobals();
    const panel = document.createElement('div');
    document.body.append(panel);
    renderChecksCatalog(panel, buildCatalog(25));

    const pag = panel.querySelector<HTMLElement>('.pagination')!;
    expect(pag).not.toBeNull();
    // Second page navigation works on the initial (grouped) paginator.
    clickButtonWithText(pag, 'Next →');
    let visibleSlugs = [...panel.querySelectorAll<HTMLElement>('tbody tr')]
      .filter((r) => r.style.display !== 'none' && r.dataset.slug)
      .map((r) => r.dataset.slug);
    expect(visibleSlugs).toContain('check-10');
    expect(visibleSlugs).not.toContain('check-00');

    // Type a filter that matches a subset spanning >1 page → triggers
    // paginateFilteredGroups on the SAME `pag` container (re-wire path).
    const search = panel.querySelector<HTMLInputElement>('input.search-input')!;
    search.value = 'check-';
    search.dispatchEvent(new Event('input', { bubbles: true }));

    // The (re-wired) delegated listener must still drive the FILTERED paginator:
    // page 1 of the filtered set, then Next → filtered page 2.
    const pag2 = panel.querySelector<HTMLElement>('.pagination')!;
    clickButtonWithText(pag2, 'Next →');
    visibleSlugs = [...panel.querySelectorAll<HTMLElement>('tbody tr')]
      .filter((r) => r.style.display !== 'none' && r.dataset.slug)
      .map((r) => r.dataset.slug);
    // Filtered page 2 shows the second window of matches (not the first 10).
    expect(visibleSlugs).toContain('check-10');
    expect(visibleSlugs).not.toContain('check-00');
  });
});
