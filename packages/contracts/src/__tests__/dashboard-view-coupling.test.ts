/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * View 4 (Package coupling) — N×N matrix + drilldown.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { dashboardEditorLinkJs } from '../persistence/dashboard/code-paths/editor-link.js';
import { dashboardFiltersJs } from '../persistence/dashboard/code-paths/filters.js';
import { dashboardFunctionCardJs } from '../persistence/dashboard/code-paths/function-card.js';
import { dashboardFunctionRowJs } from '../persistence/dashboard/code-paths/function-row.js';
import { dashboardIndexesJs } from '../persistence/dashboard/code-paths/indexes.js';
import { dashboardPathUtilsJs } from '../persistence/dashboard/code-paths/path-utils.js';
import { dashboardTraceJs } from '../persistence/dashboard/code-paths/trace.js';
import { dashboardViewCouplingJs } from '../persistence/dashboard/code-paths/view-coupling.js';
import { dashboardViewsRegistryJs } from '../persistence/dashboard/code-paths/views-registry.js';

import type { GraphCatalog, GraphFunctionOccurrence } from '../persistence/dashboard/code-paths/types.js';

interface Env {
  views: { id: string; render: (c: HTMLElement, cat: GraphCatalog, idx: unknown, fs: unknown) => void }[];
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
    elSrc
      + dashboardPathUtilsJs()
      + dashboardIndexesJs()
      + dashboardViewsRegistryJs()
      + dashboardFiltersJs()
      + dashboardFunctionRowJs()
      + dashboardEditorLinkJs()
      + dashboardTraceJs()
      + dashboardFunctionCardJs()
      + dashboardViewCouplingJs()
      + tail,
  );
  return factory() as Env;
}

function makeOcc(over: Partial<GraphFunctionOccurrence> & { bodyHash: string; simpleName: string; filePath: string }): GraphFunctionOccurrence {
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

beforeEach(() => { document.body.innerHTML = ''; });

describe('View 4 — Coupling matrix', () => {
  it('renders an N×N matrix with the right cell counts for two packages', () => {
    const catalog: GraphCatalog = {
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: {
        a: [makeOcc({ bodyHash: 'a', simpleName: 'a', filePath: 'packages/cli/src/a.ts',
          calls: [{ to: ['x', 'y'], line: 1, column: 0, resolution: 'static', confidence: 'high', text: '...' }] })],
        b: [makeOcc({ bodyHash: 'b', simpleName: 'b', filePath: 'packages/cli/src/b.ts',
          calls: [{ to: ['x'], line: 1, column: 0, resolution: 'static', confidence: 'high', text: '...' }] })],
        x: [makeOcc({ bodyHash: 'x', simpleName: 'x', filePath: 'packages/contracts/src/x.ts' })],
        y: [makeOcc({ bodyHash: 'y', simpleName: 'y', filePath: 'packages/contracts/src/y.ts' })],
      },
    };
    const env = loadEnv(catalog);
    const c = document.createElement('div');
    env.views.find(v => v.id === 'coupling')!.render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    const cliRow = c.querySelector('td.coupling-cell[data-caller="cli"][data-callee="contracts"]');
    expect(cliRow).not.toBeNull();
    expect(cliRow!.textContent).toBe('3'); // a→x, a→y, b→x
  });

  it('opens a drilldown card listing the call sites when a cell is clicked', () => {
    const catalog: GraphCatalog = {
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: {
        caller: [makeOcc({ bodyHash: 'c1', simpleName: 'caller', filePath: 'packages/cli/src/c.ts',
          calls: [{ to: ['t1'], line: 7, column: 0, resolution: 'static', confidence: 'high', text: 'target()' }] })],
        target: [makeOcc({ bodyHash: 't1', simpleName: 'target', filePath: 'packages/contracts/src/t.ts' })],
      },
    };
    const env = loadEnv(catalog);
    const c = document.createElement('div');
    env.views.find(v => v.id === 'coupling')!.render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    const cell = c.querySelector('td.coupling-cell[data-caller="cli"][data-callee="contracts"]')!;
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const overlay = document.querySelector('.function-card-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay!.textContent).toContain('cli → contracts');
    expect(overlay!.textContent).toContain('caller');
    expect(overlay!.textContent).toContain('target');
  });

  it('emits an empty cell shape when there are no calls in this direction', () => {
    const catalog: GraphCatalog = {
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: {
        a: [makeOcc({ bodyHash: 'a', simpleName: 'a', filePath: 'packages/cli/src/a.ts',
          calls: [{ to: ['b'], line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'b()' }] })],
        b: [makeOcc({ bodyHash: 'b', simpleName: 'b', filePath: 'packages/cli/src/b.ts' })],
      },
    };
    const env = loadEnv(catalog);
    const c = document.createElement('div');
    env.views.find(v => v.id === 'coupling')!.render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    // cli→contracts has no calls; the diagonal (cli→cli) does. There is no
    // 'contracts' caller, so the matrix is 1×1.
    const cells = c.querySelectorAll('td.coupling-cell');
    expect(cells.length).toBe(1);
    expect(cells[0].textContent).toBe('1');
  });
});
