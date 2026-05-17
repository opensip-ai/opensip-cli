/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * View 1 (Hot functions) tests.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { dashboardFiltersJs } from '../persistence/dashboard/code-paths/filters.js';
import { dashboardFunctionRowJs } from '../persistence/dashboard/code-paths/function-row.js';
import { dashboardIndexesJs } from '../persistence/dashboard/code-paths/indexes.js';
import { dashboardPathUtilsJs } from '../persistence/dashboard/code-paths/path-utils.js';
import { dashboardViewHotJs } from '../persistence/dashboard/code-paths/view-hot.js';
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
      + dashboardViewHotJs()
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

describe('View 1 — Hot functions', () => {
  it('sorts by inbound call count descending and shows up to top 50', () => {
    // Build 60 functions where target_i is called by callers_0..i.
    const fns: Record<string, GraphFunctionOccurrence[]> = {};
    for (let i = 0; i < 60; i++) {
      const calls = [];
      for (let j = 0; j < i; j++) calls.push('h' + j);
      // Each function 'fi' calls all f0..f_{i-1}.
      fns['f' + i] = [makeOcc({
        bodyHash: 'h' + i,
        simpleName: 'f' + i,
        calls: calls.length > 0 ? [{ to: calls, line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'fns()' }] : [],
      })];
    }
    const catalog: GraphCatalog = { version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now', functions: fns };
    const env = loadEnv(catalog);
    const c = document.createElement('div');
    env.views.find(v => v.id === 'hot')!.render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    const rows = c.querySelectorAll('tr.clickable');
    expect(rows.length).toBe(50);
    // f0 has the most callers (called by f1..f59 = 59), f1 is called by f2..f59 = 58, etc.
    const firstRowName = rows[0].children[0].textContent;
    expect(firstRowName).toBe('f0');
  });

  it('emits the empty-state when the catalog has no called functions', () => {
    const catalog: GraphCatalog = { version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now', functions: {} };
    const env = loadEnv(catalog);
    const c = document.createElement('div');
    env.views.find(v => v.id === 'hot')!.render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    expect(c.querySelector('.empty')).not.toBeNull();
  });

  it('every row has the data-body-hash attribute (so click delegation works)', () => {
    const catalog: GraphCatalog = {
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: {
        a: [makeOcc({ bodyHash: 'ha', simpleName: 'a' })],
        b: [makeOcc({ bodyHash: 'hb', simpleName: 'b', calls: [{ to: ['ha'], line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'a()' }] })],
      },
    };
    const env = loadEnv(catalog);
    const c = document.createElement('div');
    env.views.find(v => v.id === 'hot')!.render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    const rows = c.querySelectorAll('tr.clickable[data-body-hash]');
    expect(rows.length).toBeGreaterThan(0);
  });

  it('package filter removes rows whose package is outside the active set', () => {
    const catalog: GraphCatalog = {
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: {
        a: [makeOcc({ bodyHash: 'ha', simpleName: 'a', filePath: 'packages/cli/src/a.ts' })],
        b: [makeOcc({ bodyHash: 'hb', simpleName: 'b', filePath: 'packages/contracts/src/b.ts',
          calls: [{ to: ['ha'], line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'a()' }] })],
      },
    };
    const env = loadEnv(catalog);
    env.filterState.packages.add('contracts');
    const c = document.createElement('div');
    env.views.find(v => v.id === 'hot')!.render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    // 'a' is in cli (filtered out); the only candidate ('a') is gone, expect empty state.
    expect(c.querySelector('.empty')).not.toBeNull();
  });
});
