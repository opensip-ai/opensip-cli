/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * View 8 (Graph) — Cytoscape node-link view.
 *
 * The emitter is snapshotted (matches the other view-*.test.ts pattern)
 * and exercised structurally: the view registers with id 'graph', renders
 * the layout selector + canvas from an embedded view-model blob, falls
 * back to an empty state when the blob is missing, and bans any
 * @opensip-tools/graph import.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { dashboardCytoscapeVendorJs } from '../code-paths/cytoscape-vendor.js';
import { dashboardFiltersJs } from '../code-paths/filters.js';
import { dashboardIndexesJs } from '../code-paths/indexes.js';
import { dashboardPathUtilsJs } from '../code-paths/path-utils.js';
import { dashboardViewGraphJs } from '../code-paths/view-graph.js';
import { dashboardViewsRegistryJs } from '../code-paths/views-registry.js';

interface GraphView {
  id: string;
  label: string;
  render: (c: HTMLElement, cat: unknown, idx: unknown, fs: unknown) => void;
  onActivate?: () => void;
}

interface Env {
  views: GraphView[];
}

function loadEnv(withVendor: boolean): Env {
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
var graphCatalog = null;
var graphIndexes = { byBodyHash: new Map(), bySimpleName: new Map(), callees: new Map(), callers: new Map() };
`;
  const tail = `
return { views };
`;
  const parts = [elSrc];
  if (withVendor) parts.push(dashboardCytoscapeVendorJs());
  parts.push(
    dashboardPathUtilsJs(),
    dashboardIndexesJs(),
    dashboardViewsRegistryJs(),
    dashboardFiltersJs(),
    dashboardViewGraphJs(),
    tail,
  );
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source.
  const factory = new Function(parts.join('\n'));
  return factory() as Env;
}

function embedViewModel(vm: unknown): void {
  const blob = document.createElement('script');
  blob.type = 'application/json';
  blob.id = 'graph-view-model';
  blob.textContent = JSON.stringify(vm);
  document.body.append(blob);
}

const SAMPLE_VM = {
  language: 'typescript',
  nodes: [
    {
      id: 'a',
      label: 'pkg/mod.alpha',
      filePath: 'packages/x/src/a.ts',
      kind: 'function-declaration',
      visibility: 'exported',
      inTestFile: false,
      callDegreeIn: 0,
      callDegreeOut: 1,
      sccId: null,
    },
    {
      id: 'b',
      label: 'pkg/mod.beta',
      filePath: 'packages/x/src/b.ts',
      kind: 'method',
      visibility: 'private',
      inTestFile: true,
      callDegreeIn: 1,
      callDegreeOut: 0,
      sccId: null,
    },
  ],
  edges: [
    { source: 'a', target: 'b', resolution: 'static', confidence: 'high', isCycleEdge: false },
  ],
};

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('dashboardViewGraphJs (emitter)', () => {
  it('matches the snapshot', () => {
    expect(dashboardViewGraphJs()).toMatchSnapshot();
  });

  it('imports nothing from @opensip-tools/graph', () => {
    expect(dashboardViewGraphJs()).not.toContain('@opensip-tools/graph');
  });
});

describe('View 8 — Graph', () => {
  it('registers a graph view with id and label', () => {
    const env = loadEnv(false);
    const view = env.views.find(v => v.id === 'graph');
    expect(view).toBeDefined();
    expect(view!.label).toBe('Graph');
    expect(typeof view!.render).toBe('function');
    expect(typeof view!.onActivate).toBe('function');
  });

  it('renders the empty state when no view-model blob is present', () => {
    const env = loadEnv(false);
    const c = document.createElement('div');
    env.views.find(v => v.id === 'graph')!.render(c, null, null, null);
    expect(c.querySelector('.empty')).not.toBeNull();
    expect(c.querySelector('.empty')!.textContent).toContain('No graph to display');
  });

  it('renders the renderer-unavailable state when cytoscape is missing', () => {
    const env = loadEnv(false); // no vendor → no cytoscape global
    embedViewModel(SAMPLE_VM);
    const c = document.createElement('div');
    document.body.append(c);
    env.views.find(v => v.id === 'graph')!.render(c, null, null, null);
    // With no cytoscape global the view short-circuits to the unavailable
    // empty state before mounting the toolbar/canvas.
    expect(c.querySelector('.empty')!.textContent).toContain('Graph renderer unavailable');
    expect(c.querySelector('#code-paths-graph-canvas')).toBeNull();
  });

  it('renders the layout selector with dagre/cose/breadthfirst', () => {
    const env = loadEnv(true);
    embedViewModel(SAMPLE_VM);
    const c = document.createElement('div');
    document.body.append(c);
    env.views.find(v => v.id === 'graph')!.render(c, null, null, null);
    const btns = [...c.querySelectorAll<HTMLElement>('.code-paths-graph-layout-btn')].map(
      b => b.dataset.layout,
    );
    expect(btns).toEqual(['dagre', 'cose', 'breadthfirst']);
    expect(
      c.querySelector<HTMLElement>('.code-paths-graph-layout-btn.active')!.dataset.layout,
    ).toBe('dagre');
  });

  it('mounts a cytoscape canvas when the renderer is present', () => {
    const env = loadEnv(true);
    embedViewModel(SAMPLE_VM);
    const c = document.createElement('div');
    document.body.append(c);
    env.views.find(v => v.id === 'graph')!.render(c, null, null, null);
    expect(c.querySelector('#code-paths-graph-canvas')).not.toBeNull();
  });

  it('shows the truncation banner when truncatedFromTotal is set', () => {
    const env = loadEnv(true);
    embedViewModel({ ...SAMPLE_VM, truncatedFromTotal: 9999 });
    const c = document.createElement('div');
    document.body.append(c);
    env.views.find(v => v.id === 'graph')!.render(c, null, null, null);
    const banner = c.querySelector('.code-paths-graph-banner');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain('Showing top 2 of 9999');
  });
});
