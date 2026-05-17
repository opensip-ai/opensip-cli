/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * View 3 (Wide functions) — sorted by params.length.
 */

import { describe, expect, it } from 'vitest';

import { dashboardFiltersJs } from '../persistence/dashboard/code-paths/filters.js';
import { dashboardFunctionRowJs } from '../persistence/dashboard/code-paths/function-row.js';
import { dashboardIndexesJs } from '../persistence/dashboard/code-paths/indexes.js';
import { dashboardPathUtilsJs } from '../persistence/dashboard/code-paths/path-utils.js';
import { dashboardViewWideJs } from '../persistence/dashboard/code-paths/view-wide.js';
import { dashboardViewsRegistryJs } from '../persistence/dashboard/code-paths/views-registry.js';

import type { GraphCatalog, GraphFunctionOccurrence, GraphParam } from '../persistence/dashboard/code-paths/types.js';

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
      + dashboardViewWideJs()
      + tail,
  );
  return factory() as Env;
}

function p(name: string, optional = false, rest = false): GraphParam { return { name, optional, rest }; }

function makeOcc(over: Partial<GraphFunctionOccurrence> & { bodyHash: string; simpleName: string; params: readonly GraphParam[] }): GraphFunctionOccurrence {
  return {
    qualifiedName: over.simpleName,
    filePath: 'packages/x/src/x.ts',
    line: 1,
    column: 0,
    endLine: 5,
    kind: 'function-declaration',
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

describe('View 3 — Wide functions', () => {
  it('sorts by params.length descending and renders all parameterized functions (paginated)', () => {
    const fns: Record<string, GraphFunctionOccurrence[]> = {};
    for (let i = 1; i < 25; i++) {
      const params: GraphParam[] = [];
      for (let j = 0; j < i; j++) params.push(p('p' + j));
      fns['f' + i] = [makeOcc({ bodyHash: 'h' + i, simpleName: 'f' + i, params })];
    }
    const env = loadEnv({ version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now', functions: fns });
    const c = document.createElement('div');
    env.views.find(v => v.id === 'wide')!.render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    const rows = c.querySelectorAll('tr.clickable');
    expect(rows.length).toBe(24);
    expect(c.querySelector('.section > h3')!.textContent).toContain('Wide functions');
    expect(c.querySelector('.card > .pagination')).not.toBeNull();
    const firstRowName = rows[0].children[0].textContent;
    expect(firstRowName).toBe('f24');
  });

  it('renders a parameter thumbnail with rest and optional markers', () => {
    const params: GraphParam[] = [p('a'), p('b', true), p('c', false, true)];
    const catalog: GraphCatalog = {
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: { f: [makeOcc({ bodyHash: 'h1', simpleName: 'f', params })] },
    };
    const env = loadEnv(catalog);
    const c = document.createElement('div');
    env.views.find(v => v.id === 'wide')!.render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    const sigCell = c.querySelectorAll('tr.clickable')[0].children[2];
    expect(sigCell.textContent).toContain('a');
    expect(sigCell.textContent).toContain('b?');
    expect(sigCell.textContent).toContain('...c');
  });

  it('skips zero-arity functions', () => {
    const catalog: GraphCatalog = {
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: { f: [makeOcc({ bodyHash: 'h1', simpleName: 'f', params: [] })] },
    };
    const env = loadEnv(catalog);
    const c = document.createElement('div');
    env.views.find(v => v.id === 'wide')!.render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    expect(c.querySelector('.empty')).not.toBeNull();
  });
});
