/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * View 4 (Package coupling) — N×N matrix + drilldown.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { dashboardEditorLinkJs } from '../code-paths/editor-link.js';
import { dashboardFiltersJs } from '../code-paths/filters.js';
import { dashboardFunctionCardJs } from '../code-paths/function-card.js';
import { dashboardFunctionRowJs } from '../code-paths/function-row.js';
import { dashboardIndexesJs } from '../code-paths/indexes.js';
import { dashboardPathUtilsJs } from '../code-paths/path-utils.js';
import { dashboardTraceJs } from '../code-paths/trace.js';
import { dashboardViewCouplingJs } from '../code-paths/view-coupling.js';
import { dashboardViewsRegistryJs } from '../code-paths/views-registry.js';

import type { GraphCatalog, GraphFunctionOccurrence } from '@opensip-tools/contracts';

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
      // Engine-emitted edge feature: cli→contracts has 3 call sites (a→x, a→y, b→x).
      features: { edge: [{ callerPackage: 'cli', calleePackage: 'contracts', count: 3 }] },
    };
    const env = loadEnv(catalog);
    const c = document.createElement('div');
    env.views.find(v => v.id === 'coupling')!.render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    const cliRow = c.querySelector('td.coupling-cell[data-caller="cli"][data-callee="contracts"]');
    expect(cliRow).not.toBeNull();
    expect(cliRow!.textContent).toBe('3'); // a→x, a→y, b→x
  });

  it('wraps the table in a bounded scroll container so a large matrix stays on the page', () => {
    const catalog: GraphCatalog = {
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: {
        a: [makeOcc({ bodyHash: 'a', simpleName: 'a', filePath: 'packages/cli/src/a.ts',
          calls: [{ to: ['x'], line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'x()' }] })],
        x: [makeOcc({ bodyHash: 'x', simpleName: 'x', filePath: 'packages/contracts/src/x.ts' })],
      },
      features: { edge: [{ callerPackage: 'cli', calleePackage: 'contracts', count: 1 }] },
    };
    const env = loadEnv(catalog);
    const c = document.createElement('div');
    env.views.find(v => v.id === 'coupling')!.render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    const scroll = c.querySelector('.coupling-scroll');
    expect(scroll).not.toBeNull();
    // The table must live *inside* the scroll container — that's what gives it
    // both scrollbars instead of overflowing the page.
    expect(scroll!.querySelector('table.coupling-table')).not.toBeNull();
  });

  it('opens a drilldown card listing the call sites when a cell is clicked', () => {
    const catalog: GraphCatalog = {
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: {
        caller: [makeOcc({ bodyHash: 'c1', simpleName: 'caller', filePath: 'packages/cli/src/c.ts',
          calls: [{ to: ['t1'], line: 7, column: 0, resolution: 'static', confidence: 'high', text: 'target()' }] })],
        target: [makeOcc({ bodyHash: 't1', simpleName: 'target', filePath: 'packages/contracts/src/t.ts' })],
      },
      features: { edge: [{ callerPackage: 'cli', calleePackage: 'contracts', count: 1 }] },
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
      // Only the cli→cli diagonal edge ⇒ a 1×1 matrix.
      features: { edge: [{ callerPackage: 'cli', calleePackage: 'cli', count: 1 }] },
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

  it('shows the no-data empty state when the catalog carries no edge feature', () => {
    const catalog: GraphCatalog = {
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: {
        a: [makeOcc({ bodyHash: 'a', simpleName: 'a', filePath: 'packages/cli/src/a.ts',
          calls: [{ to: ['x'], line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'x()' }] })],
        x: [makeOcc({ bodyHash: 'x', simpleName: 'x', filePath: 'packages/contracts/src/x.ts' })],
      },
      // No features blob (a non-dashboard run) ⇒ no client recompute, no-data state.
    };
    const env = loadEnv(catalog);
    const c = document.createElement('div');
    env.views.find(v => v.id === 'coupling')!.render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    expect(c.querySelector('.empty')).not.toBeNull();
    expect(c.querySelector('td.coupling-cell')).toBeNull();
  });
});
