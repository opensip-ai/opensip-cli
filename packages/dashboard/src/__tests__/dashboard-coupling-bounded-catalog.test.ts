/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * The coupling matrix's documented invariant, held across bounding.
 *
 * `client/view-coupling.ts` states it outright: the matrix and its drilldown
 * enumerate the same population, "so a non-empty cell can never resolve to 'No
 * call sites found'". The cells come from `features.edge`; the drilldown walks
 * `functions`. Once `boundGraphCatalog` truncates `functions` to fit the report
 * byte budget, an unfiltered `features.edge` describes a population the page no
 * longer carries — a cell reading "42" that opens onto nothing.
 *
 * This boots the real bounded catalog through the real client bundle and clicks
 * every cell the matrix renders.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { DASHBOARD_CLIENT_BUNDLE } from '../client-bundle.generated.js';
import { boundGraphCatalog } from '../code-paths/bound-catalog.js';

import type { GraphCatalog } from '@opensip-cli/contracts';

interface Env {
  views: {
    id: string;
    render: (container: HTMLElement, catalog: unknown, indexes: unknown, filters: unknown) => void;
  }[];
  graphCatalog: unknown;
  graphIndexes: unknown;
  filterState: unknown;
}

function loadEnv(catalog: unknown): Env {
  const head = `
var sessions = [];
var EDITOR_PROTOCOL = null;
var graphCatalog = null;
var graphIndexes = null;
`;
  const tail = `
graphCatalog = ${JSON.stringify(catalog)};
graphIndexes = buildIndexes(graphCatalog);
return { views, graphCatalog, graphIndexes, filterState };
`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: our own bundled dashboard JS.
  const factory = new Function(head + DASHBOARD_CLIENT_BUNDLE + tail);
  return factory() as Env;
}

function occurrence(over: Record<string, unknown>): Record<string, unknown> {
  return {
    simpleName: 'fn',
    qualifiedName: 'fn',
    line: 1,
    column: 0,
    endLine: 2,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    visibility: 'exported',
    inTestFile: false,
    calls: [],
    ...over,
  };
}

function call(target: string): Record<string, unknown> {
  return {
    to: [target],
    line: 3,
    column: 0,
    resolution: 'static',
    confidence: 'high',
    text: 'callee()',
  };
}

/**
 * `hot → cold` survives bounding; `cold-caller → cold-callee` does not — its
 * occurrences are heavy and carry the lowest blast score, so the importance
 * ranking drops them first. Both pairs are present in `features.edge`.
 */
function catalogUnderBudget(): GraphCatalog {
  const functions = {
    hotCaller: [
      occurrence({
        bodyHash: 'hot-caller',
        simpleName: 'hotCaller',
        qualifiedName: 'hot.hotCaller',
        package: 'hot',
        filePath: 'packages/hot/src/caller.ts',
        calls: [call('hot-callee')],
      }),
    ],
    hotCallee: [
      occurrence({
        bodyHash: 'hot-callee',
        simpleName: 'hotCallee',
        qualifiedName: 'cold.hotCallee',
        package: 'cold',
        filePath: 'packages/cold/src/callee.ts',
      }),
    ],
    coldCaller: [
      occurrence({
        bodyHash: 'cold-caller',
        simpleName: 'coldCaller',
        qualifiedName: 'cold-caller.coldCaller',
        package: 'cold-caller',
        filePath: 'packages/cold-caller/src/caller.ts',
        returnType: 'x'.repeat(4000),
        calls: [call('cold-callee')],
      }),
    ],
    coldCallee: [
      occurrence({
        bodyHash: 'cold-callee',
        simpleName: 'coldCallee',
        qualifiedName: 'cold-callee.coldCallee',
        package: 'cold-callee',
        filePath: 'packages/cold-callee/src/callee.ts',
        returnType: 'x'.repeat(4000),
      }),
    ],
  };
  return {
    version: '2.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-07-14T00:00:00.000Z',
    cacheKey: 'ck',
    functions,
    features: {
      function: {
        hotCaller: { bodyLines: 1, blast: { score: 100 } },
        hotCallee: { bodyLines: 1, blast: { score: 100 } },
        coldCaller: { bodyLines: 1, blast: { score: 0 } },
        coldCallee: { bodyLines: 1, blast: { score: 0 } },
      },
      edge: [
        { callerPackage: 'hot', calleePackage: 'cold', count: 1 },
        { callerPackage: 'cold-caller', calleePackage: 'cold-callee', count: 42 },
      ],
    },
  } as unknown as GraphCatalog;
}

function renderCoupling(catalog: unknown): HTMLElement {
  const env = loadEnv(catalog);
  const container = document.createElement('div');
  env.views
    .find((view) => view.id === 'coupling')!
    .render(container, env.graphCatalog, env.graphIndexes, env.filterState);
  return container;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('coupling matrix over a bounded catalog', () => {
  it('renders no cell whose drilldown has nothing to show', () => {
    const bounded = boundGraphCatalog(catalogUnderBudget(), 2000);
    expect(bounded.omittedFunctions).toBeGreaterThan(0);

    const container = renderCoupling(bounded.catalog);
    const cells = [...container.querySelectorAll<HTMLElement>('td.coupling-cell:not(.empty)')];
    expect(cells.length).toBeGreaterThan(0);

    for (const cell of cells) {
      cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const overlay = document.querySelector('.function-card-overlay');
      expect(
        overlay?.textContent,
        `${cell.dataset.caller ?? '?'} → ${cell.dataset.callee ?? '?'} counts ${cell.textContent ?? '?'} call site(s)`,
      ).not.toContain('No call sites found');
    }

    // The surviving pair is still counted; the dropped one is simply gone,
    // rather than present-but-hollow.
    expect(
      container.querySelector('td.coupling-cell[data-caller="hot"][data-callee="cold"]')
        ?.textContent,
    ).toBe('1');
    expect(container.querySelector('td.coupling-cell[data-caller="cold-caller"]')).toBeNull();
  });

  it('keeps the whole-graph matrix when the catalog fits the budget', () => {
    const bounded = boundGraphCatalog(catalogUnderBudget(), 64 * 1024 * 1024);
    expect(bounded.omittedFunctions).toBe(0);

    const container = renderCoupling(bounded.catalog);

    expect(
      container.querySelector('td.coupling-cell[data-caller="hot"][data-callee="cold"]')
        ?.textContent,
    ).toBe('1');
    expect(
      container.querySelector(
        'td.coupling-cell[data-caller="cold-caller"][data-callee="cold-callee"]',
      )?.textContent,
    ).toBe('42');
  });
});
