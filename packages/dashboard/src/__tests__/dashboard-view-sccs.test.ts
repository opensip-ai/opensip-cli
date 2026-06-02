/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * View 6 (Cycles / SCCs) tests — top-10 truncation and row shape.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { dashboardFiltersJs } from '../code-paths/filters.js';
import { dashboardFunctionRowJs } from '../code-paths/function-row.js';
import { dashboardIndexesJs } from '../code-paths/indexes.js';
import { dashboardPathUtilsJs } from '../code-paths/path-utils.js';
import { dashboardViewSccsJs } from '../code-paths/view-sccs.js';
import { dashboardViewsRegistryJs } from '../code-paths/views-registry.js';

import type { GraphCatalog, GraphFunctionOccurrence } from '@opensip-tools/contracts';

interface Env {
  views: { id: string; render: (c: HTMLElement, cat: GraphCatalog, idx: unknown, fs: unknown) => void }[];
  graphCatalog: GraphCatalog;
  graphIndexes: { byBodyHash: Map<string, GraphFunctionOccurrence>; callers: Map<string, string[]>; callees: Map<string, string[]> };
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
      + dashboardViewSccsJs()
      + tail,
  );
  return factory() as Env;
}

function makeOcc(over: Partial<GraphFunctionOccurrence> & { bodyHash: string; simpleName: string }): GraphFunctionOccurrence {
  return {
    qualifiedName: over.simpleName,
    filePath: 'packages/x/src/x.ts',
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

describe('View 6 — SCCs', () => {
  it('shows the empty state when there are no cycles', () => {
    const catalog: GraphCatalog = {
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: {
        a: [makeOcc({ bodyHash: 'a', simpleName: 'a',
          calls: [{ to: ['b'], line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'b()' }] })],
        b: [makeOcc({ bodyHash: 'b', simpleName: 'b' })],
      },
      // Engine emitted an scc feature with no size-≥2 components ⇒ DAG empty state.
      features: { scc: [] },
    };
    const env = loadEnv(catalog);
    const c = document.createElement('div');
    env.views.find(v => v.id === 'sccs')!.render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    expect(c.querySelector('.empty')).not.toBeNull();
  });

  it('shows the no-data empty state when the catalog carries no scc feature', () => {
    const catalog: GraphCatalog = {
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: {
        a: [makeOcc({ bodyHash: 'a', simpleName: 'a' })],
      },
    };
    const env = loadEnv(catalog);
    const c = document.createElement('div');
    env.views.find(v => v.id === 'sccs')!.render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    expect(c.querySelector('.empty')).not.toBeNull();
  });

  it('renders one row per SCC of size ≥ 2 with size, member preview, and packages', () => {
    const catalog: GraphCatalog = {
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: {
        a: [makeOcc({ bodyHash: 'a', simpleName: 'a', filePath: 'packages/cli/src/a.ts',
          calls: [{ to: ['b'], line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'b()' }] })],
        b: [makeOcc({ bodyHash: 'b', simpleName: 'b', filePath: 'packages/contracts/src/b.ts',
          calls: [{ to: ['a'], line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'a()' }] })],
      },
      // The engine 'scc' feature carries the 2-cycle; the view reads it directly.
      features: { scc: [{ id: 'scc:a', members: ['a', 'b'], sccSize: 2, crossesPackages: true }] },
    };
    const env = loadEnv(catalog);
    const c = document.createElement('div');
    env.views.find(v => v.id === 'sccs')!.render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    const rows = c.querySelectorAll('tbody tr');
    expect(rows.length).toBe(1);
    expect(rows[0].children[0].textContent).toBe('2');
    expect(rows[0].children[1].textContent).toContain('a');
    expect(rows[0].children[1].textContent).toContain('b');
    expect(rows[0].children[2].textContent).toContain('cli');
    expect(rows[0].children[2].textContent).toContain('contracts');
  });
});
