/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * View 2 (Big functions) — sorted by body length.
 */

import { describe, expect, it } from 'vitest';

import { dashboardFiltersJs } from '../persistence/dashboard/code-paths/filters.js';
import { dashboardFunctionRowJs } from '../persistence/dashboard/code-paths/function-row.js';
import { dashboardIndexesJs } from '../persistence/dashboard/code-paths/indexes.js';
import { dashboardPathUtilsJs } from '../persistence/dashboard/code-paths/path-utils.js';
import { dashboardViewBigJs } from '../persistence/dashboard/code-paths/view-big.js';
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
      + dashboardViewBigJs()
      + tail,
  );
  return factory() as Env;
}

function makeOcc(over: Partial<GraphFunctionOccurrence> & { bodyHash: string; simpleName: string; line: number; endLine: number }): GraphFunctionOccurrence {
  return {
    qualifiedName: over.simpleName,
    filePath: 'packages/x/src/x.ts',
    column: 0,
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

describe('View 2 — Big functions', () => {
  it('sorts by endLine - line descending and renders all functions (paginated)', () => {
    const fns: Record<string, GraphFunctionOccurrence[]> = {};
    for (let i = 0; i < 35; i++) {
      fns['f' + i] = [makeOcc({ bodyHash: 'h' + i, simpleName: 'f' + i, line: 1, endLine: i + 5 })];
    }
    const env = loadEnv({ version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now', functions: fns });
    const c = document.createElement('div');
    env.views.find(v => v.id === 'big')!.render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    const rows = c.querySelectorAll('tr.clickable');
    expect(rows.length).toBe(35);
    expect(c.querySelector('.section > h3')!.textContent).toContain('Big functions');
    expect(c.querySelector('.card > .pagination')).not.toBeNull();
    const firstRowName = rows[0].children[0].textContent;
    expect(firstRowName).toBe('f34');
  });

  it('renders the empty state when nothing matches', () => {
    const env = loadEnv({ version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now', functions: {} });
    const c = document.createElement('div');
    env.views.find(v => v.id === 'big')!.render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    expect(c.querySelector('.empty')).not.toBeNull();
  });
});
