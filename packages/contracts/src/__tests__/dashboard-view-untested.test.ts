/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * View 5 (Untested production code) tests.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { dashboardFiltersJs } from '../persistence/dashboard/code-paths/filters.js';
import { dashboardFunctionRowJs } from '../persistence/dashboard/code-paths/function-row.js';
import { dashboardIndexesJs } from '../persistence/dashboard/code-paths/indexes.js';
import { dashboardPathUtilsJs } from '../persistence/dashboard/code-paths/path-utils.js';
import { dashboardViewUntestedJs } from '../persistence/dashboard/code-paths/view-untested.js';
import { dashboardViewsRegistryJs } from '../persistence/dashboard/code-paths/views-registry.js';

import type { GraphCatalog, GraphFunctionOccurrence } from '../persistence/dashboard/code-paths/types.js';

interface Env {
  views: { id: string; render: (c: HTMLElement, cat: GraphCatalog, idx: unknown, fs: unknown) => void }[];
  graphCatalog: GraphCatalog;
  graphIndexes: { byBodyHash: Map<string, GraphFunctionOccurrence>; callers: Map<string, string[]> };
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
`;
  const tail = `
var graphCatalog = ${JSON.stringify(catalog)};
var graphIndexes = buildIndexes(graphCatalog);
return { views, graphCatalog, graphIndexes, filterState };
`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source.
  const factory = new Function(
    elSrc
      + dashboardPathUtilsJs()
      + dashboardIndexesJs()
      + dashboardViewsRegistryJs()
      + dashboardFiltersJs()
      + dashboardFunctionRowJs()
      + dashboardViewUntestedJs()
      + tail,
  );
  return factory() as Env;
}

function makeOcc(over: Partial<GraphFunctionOccurrence> & { bodyHash: string; simpleName: string }): GraphFunctionOccurrence {
  return {
    qualifiedName: over.simpleName,
    filePath: 'packages/contracts/src/x.ts',
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

beforeEach(() => { document.body.innerHTML = ''; });

describe('View 5 — Untested production code', () => {
  it('skips functions with at least one test caller', () => {
    const catalog: GraphCatalog = {
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: {
        target: [makeOcc({ bodyHash: 't1', simpleName: 'target' })],
        testCaller: [makeOcc({ bodyHash: 'tc', simpleName: 'testCaller', filePath: 'packages/x/src/__tests__/x.test.ts', inTestFile: true,
          calls: [{ to: ['t1'], line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'target()' }] })],
      },
    };
    const env = loadEnv(catalog);
    const c = document.createElement('div');
    env.views.find(v => v.id === 'untested')!.render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    expect(c.querySelector('.empty')).not.toBeNull();
  });

  it('lists production functions with no test callers', () => {
    const catalog: GraphCatalog = {
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: {
        target: [makeOcc({ bodyHash: 't1', simpleName: 'target' })],
        prodCaller: [makeOcc({ bodyHash: 'pc', simpleName: 'prodCaller',
          calls: [{ to: ['t1'], line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'target()' }] })],
      },
    };
    const env = loadEnv(catalog);
    const c = document.createElement('div');
    env.views.find(v => v.id === 'untested')!.render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    const rows = c.querySelectorAll('tr.clickable');
    // Both 'target' and 'prodCaller' qualify (neither has a test caller).
    expect(rows.length).toBe(2);
  });

  it('lists functions with zero callers at all', () => {
    const catalog: GraphCatalog = {
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: { lonely: [makeOcc({ bodyHash: 'l1', simpleName: 'lonely' })] },
    };
    const env = loadEnv(catalog);
    const c = document.createElement('div');
    env.views.find(v => v.id === 'untested')!.render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    expect(c.querySelectorAll('tr.clickable').length).toBe(1);
  });

  it('skips functions defined in test files (test files are not the target audience)', () => {
    const catalog: GraphCatalog = {
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: { tf: [makeOcc({ bodyHash: 'tf1', simpleName: 'tf', filePath: 'packages/x/src/__tests__/x.test.ts', inTestFile: true })] },
    };
    const env = loadEnv(catalog);
    const c = document.createElement('div');
    env.views.find(v => v.id === 'untested')!.render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    expect(c.querySelector('.empty')).not.toBeNull();
  });
});
