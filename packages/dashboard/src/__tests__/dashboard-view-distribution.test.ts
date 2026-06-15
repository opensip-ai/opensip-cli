/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * Functions (distribution) view — the ranked-distribution affordance that
 * also hosts the in-table name filter folded in from the former standalone
 * Search subtab. Verifies the search input renders above the table and
 * re-filters the rows in place by function simple-name.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { dashboardEditorLinkJs } from '../code-paths/editor-link.js';
import { dashboardFiltersJs } from '../code-paths/filters.js';
import { dashboardFunctionCardJs } from '../code-paths/function-card.js';
import { dashboardFunctionRowJs } from '../code-paths/function-row.js';
import { dashboardHelpDrawerJs } from '../code-paths/help-drawer.js';
import { dashboardIndexesJs } from '../code-paths/indexes.js';
import { dashboardPathUtilsJs } from '../code-paths/path-utils.js';
import { dashboardTraceJs } from '../code-paths/trace.js';
import { dashboardViewDistributionJs } from '../code-paths/view-distribution.js';
import { dashboardViewsRegistryJs } from '../code-paths/views-registry.js';

import type { GraphCatalog, GraphFunctionOccurrence } from '@opensip-cli/contracts';

interface Env {
  views: {
    id: string;
    render: (c: HTMLElement, cat: GraphCatalog, idx: unknown, fs: unknown) => void;
  }[];
  graphCatalog: GraphCatalog;
  graphIndexes: { byBodyHash: Map<string, GraphFunctionOccurrence> };
  filterState: { packages: Set<string>; kinds: Set<string>; includeTests: boolean };
}

function loadEnv(catalog: GraphCatalog): Env {
  const elSrc = `
function el(tag, attrs, children) {
  const e = document.createElement(tag);
  if (attrs) Object.entries(attrs).forEach(([k,v]) => {
    if (k === 'text') e.textContent = v;
    else if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  });
  if (children) children.forEach(c => { if (typeof c === 'string') e.appendChild(document.createTextNode(c)); else if (c) e.appendChild(c); });
  return e;
}
var EDITOR_PROTOCOL = null;
`;
  const tail = `
var graphCatalog = ${JSON.stringify(catalog)};
var graphIndexes = buildIndexes(graphCatalog);
return { views, graphCatalog, graphIndexes, filterState };
`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source.
  const factory = new Function(
    elSrc +
      dashboardPathUtilsJs() +
      dashboardIndexesJs() +
      dashboardViewsRegistryJs() +
      dashboardFiltersJs() +
      dashboardFunctionRowJs() +
      dashboardHelpDrawerJs() +
      dashboardEditorLinkJs() +
      dashboardTraceJs() +
      dashboardFunctionCardJs() +
      dashboardViewDistributionJs() +
      tail,
  );
  return factory() as Env;
}

function makeOcc(
  over: Partial<GraphFunctionOccurrence> & {
    bodyHash: string;
    simpleName: string;
    filePath: string;
  },
): GraphFunctionOccurrence {
  return {
    qualifiedName: over.simpleName,
    line: 1,
    column: 0,
    endLine: 5,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'exported',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
    ...over,
  };
}

const catalog: GraphCatalog = {
  version: '2.0',
  tool: 'graph',
  language: 'typescript',
  builtAt: 'now',
  functions: {
    a: [makeOcc({ bodyHash: 'a', simpleName: 'validateInput', filePath: 'packages/cli/src/a.ts' })],
    b: [makeOcc({ bodyHash: 'b', simpleName: 'renderTable', filePath: 'packages/cli/src/b.ts' })],
    c: [makeOcc({ bodyHash: 'c', simpleName: 'parseConfig', filePath: 'packages/cli/src/c.ts' })],
  },
};

function renderDistribution(): { view: HTMLElement } {
  const env = loadEnv(catalog);
  const view = document.createElement('div');
  env.views
    .find((v) => v.id === 'distribution')!
    .render(view, env.graphCatalog, env.graphIndexes, env.filterState);
  return { view };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Functions (distribution) view', () => {
  it('renders a name-filter search input above the table', () => {
    const { view } = renderDistribution();
    const input = view.querySelector('#code-paths-search-distribution');
    expect(input).not.toBeNull();
    // The input must precede the rendered table in document order.
    const firstRow = view.querySelector('[data-body-hash]');
    expect(firstRow).not.toBeNull();
    expect(
      input!.compareDocumentPosition(firstRow!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('shows every function before any filtering', () => {
    const { view } = renderDistribution();
    expect(view.querySelectorAll('[data-body-hash]').length).toBe(3);
  });

  it('re-filters rows in place by simple-name substring', () => {
    const { view } = renderDistribution();
    const input = view.querySelector<HTMLInputElement>('#code-paths-search-distribution')!;
    input.value = 'parse';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const rows = view.querySelectorAll('[data-body-hash]');
    expect(rows.length).toBe(1);
    expect(view.textContent).toContain('parseConfig');
    expect(view.textContent).not.toContain('validateInput');
  });

  it('collapses to the empty state when nothing matches, and restores on clear', () => {
    const { view } = renderDistribution();
    const input = view.querySelector<HTMLInputElement>('#code-paths-search-distribution')!;
    input.value = 'zzz-no-such-name';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(view.querySelectorAll('[data-body-hash]').length).toBe(0);
    expect(view.querySelector('.empty')).not.toBeNull();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(view.querySelectorAll('[data-body-hash]').length).toBe(3);
  });

  it('renders the "Functions (N)" heading with ⓘ ABOVE the controls (like Coupling/Visualization)', () => {
    const { view } = renderDistribution();
    const heading = view.querySelector('h3');
    const info = view.querySelector('.section-info');
    const controls = view.querySelector('.code-paths-ranked-controls');
    expect(heading).not.toBeNull();
    expect(heading!.textContent).toContain('Functions (3)'); // 3 functions in the sample
    expect(info).not.toBeNull();
    expect(controls).not.toBeNull();
    // The heading must precede the controls row in document order.
    expect(
      heading!.compareDocumentPosition(controls!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('updates the heading count as the filter narrows the rows', () => {
    const { view } = renderDistribution();
    const input = view.querySelector<HTMLInputElement>('#code-paths-search-distribution')!;
    input.value = 'parse';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(view.querySelector('h3')!.textContent).toContain('Functions (1)');
  });

  it('renders Kind and Package single-select dropdowns before the search box', () => {
    const { view } = renderDistribution();
    const kind = view.querySelector<HTMLSelectElement>('select[data-control="fn-kind"]');
    const pkg = view.querySelector<HTMLSelectElement>('select[data-control="fn-package"]');
    const search = view.querySelector<HTMLInputElement>('#code-paths-search-distribution');
    expect(kind).not.toBeNull();
    expect(pkg).not.toBeNull();
    // Defaults select "all".
    expect(kind!.value).toBe('');
    expect(pkg!.value).toBe('');
    expect(kind!.options[0].textContent).toBe('All kinds');
    expect(pkg!.options[0].textContent).toBe('All packages');
    // Order in the controls row: Kind, Package, then the search box.
    expect(kind!.compareDocumentPosition(pkg!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pkg!.compareDocumentPosition(search!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('filters the table by the selected Package', () => {
    const env = loadEnv({
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        a: [
          makeOcc({
            bodyHash: 'a',
            simpleName: 'validateInput',
            filePath: 'packages/cli/src/a.ts',
          }),
        ],
        z: [
          makeOcc({
            bodyHash: 'z',
            simpleName: 'ztarget',
            filePath: 'packages/contracts/src/z.ts',
          }),
        ],
      },
    });
    const view = document.createElement('div');
    env.views
      .find((v) => v.id === 'distribution')!
      .render(view, env.graphCatalog, env.graphIndexes, env.filterState);
    expect(view.querySelectorAll('[data-body-hash]').length).toBe(2);
    const pkg = view.querySelector<HTMLSelectElement>('select[data-control="fn-package"]')!;
    pkg.value = 'contracts';
    pkg.dispatchEvent(new Event('change', { bubbles: true }));
    const rows = view.querySelectorAll('[data-body-hash]');
    expect(rows.length).toBe(1);
    expect(view.textContent).toContain('ztarget');
    expect(view.textContent).not.toContain('validateInput');
  });

  it('no longer renders a "Test-only" column', () => {
    const { view } = renderDistribution();
    const headers = [...view.querySelectorAll('th')].map((th) => th.textContent);
    expect(headers).not.toContain('Test-only');
  });

  it('the "Test-only" toggle narrows the table to test-only functions', () => {
    const edge = {
      line: 1,
      column: 0,
      resolution: 'static' as const,
      confidence: 'high' as const,
      text: 'x()',
    };
    const env = loadEnv({
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        // Production fn reached ONLY from a test file → test-only.
        prod: [
          makeOcc({ bodyHash: 'prod', simpleName: 'prodFn', filePath: 'packages/cli/src/prod.ts' }),
        ],
        // Production fn reached from production code → not test-only.
        normal: [
          makeOcc({
            bodyHash: 'normal',
            simpleName: 'normalFn',
            filePath: 'packages/cli/src/normal.ts',
          }),
        ],
        normalCaller: [
          makeOcc({
            bodyHash: 'normalCaller',
            simpleName: 'callerFn',
            filePath: 'packages/cli/src/nc.ts',
            calls: [{ to: ['normal'], ...edge }],
          }),
        ],
        // A test-file fn that calls prod (excluded from the table by production-only default).
        testFn: [
          makeOcc({
            bodyHash: 'testFn',
            simpleName: 'testFn',
            filePath: 'packages/cli/src/__tests__/t.test.ts',
            inTestFile: true,
            calls: [{ to: ['prod'], ...edge }],
          }),
        ],
      },
    });
    const view = document.createElement('div');
    env.views
      .find((v) => v.id === 'distribution')!
      .render(view, env.graphCatalog, env.graphIndexes, env.filterState);
    // Production-only by default (testFn lives in a test file) → 3 rows.
    expect(view.querySelectorAll('[data-body-hash]').length).toBe(3);
    const toggle = view.querySelector<HTMLInputElement>('input[data-control="fn-toggle"]')!;
    expect(toggle).not.toBeNull();
    // The toggle renders after the search box.
    const search = view.querySelector<HTMLInputElement>('#code-paths-search-distribution')!;
    expect(search.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    // Only the test-only production function remains.
    expect(view.querySelectorAll('[data-body-hash]').length).toBe(1);
    expect(view.textContent).toContain('prodFn');
    expect(view.textContent).not.toContain('normalFn');
  });
});
