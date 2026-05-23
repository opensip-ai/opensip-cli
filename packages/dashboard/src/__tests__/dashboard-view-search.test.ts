/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * View 7 (Search) — bound to the persistent search input.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { dashboardFiltersJs } from '../code-paths/filters.js';
import { dashboardFunctionRowJs } from '../code-paths/function-row.js';
import { dashboardIndexesJs } from '../code-paths/indexes.js';
import { dashboardPathUtilsJs } from '../code-paths/path-utils.js';
import { dashboardSearchJs } from '../code-paths/search.js';
import { dashboardViewSearchJs } from '../code-paths/view-search.js';
import { dashboardViewsRegistryJs } from '../code-paths/views-registry.js';

import type { GraphCatalog, GraphFunctionOccurrence } from '@opensip-tools/contracts';

interface Env {
  views: { id: string; render: (c: HTMLElement, cat: GraphCatalog, idx: unknown, fs: unknown) => void }[];
  graphCatalog: GraphCatalog;
  graphIndexes: { byBodyHash: Map<string, GraphFunctionOccurrence>; bySimpleName: Map<string, string[]> };
  filterState: { packages: Set<string>; kinds: Set<string>; includeTests: boolean };
  setQuery: (q: string) => void;
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
return { views, graphCatalog, graphIndexes, filterState, setQuery: q => { searchQuery = q; } };
`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source.
  const factory = new Function(
    elSrc
      + dashboardPathUtilsJs()
      + dashboardIndexesJs()
      + dashboardViewsRegistryJs()
      + dashboardFiltersJs()
      + dashboardFunctionRowJs()
      + dashboardSearchJs()
      + dashboardViewSearchJs()
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

describe('View 7 — Search', () => {
  it('shows the placeholder when query is empty', () => {
    const env = loadEnv({
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: { logger: [makeOcc({ bodyHash: 'h', simpleName: 'logger' })] },
    });
    const c = document.createElement('div');
    env.views.find(v => v.id === 'search')!.render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    // The search input lives inside the tab body.
    expect(c.querySelector('#code-paths-search-input')).not.toBeNull();
    expect(c.querySelector('.empty')).not.toBeNull();
    expect(c.querySelector('.empty')!.textContent).toContain('Type a function name above');
  });

  it('renders matching results when the query matches', () => {
    const env = loadEnv({
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: {
        logger: [makeOcc({ bodyHash: 'h1', simpleName: 'logger' })],
        format: [makeOcc({ bodyHash: 'h2', simpleName: 'format' })],
      },
    });
    env.setQuery('log');
    const c = document.createElement('div');
    env.views.find(v => v.id === 'search')!.render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    const rows = c.querySelectorAll('tr.clickable');
    expect(rows.length).toBe(1);
    expect(rows[0].children[0].textContent).toBe('logger');
  });

  it('shows no-match empty state for an unmatched query', () => {
    const env = loadEnv({
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: { logger: [makeOcc({ bodyHash: 'h', simpleName: 'logger' })] },
    });
    env.setQuery('xyzzz');
    const c = document.createElement('div');
    env.views.find(v => v.id === 'search')!.render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    expect(c.querySelector('.empty')).not.toBeNull();
    expect(c.querySelector('.empty')!.textContent).toContain('No matches');
  });
});
