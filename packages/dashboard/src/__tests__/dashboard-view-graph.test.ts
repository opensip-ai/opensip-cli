/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * View 8 (Visualization) — Cytoscape PACKAGE node-link view (item 10/11).
 *
 * The emitter is snapshotted (matches the other view-*.test.ts pattern) and
 * exercised structurally: the view registers with id 'graph' and label
 * 'Visualization', renders the layout selector + canvas from an embedded
 * package-level view-model blob, falls back to an empty state when the blob is
 * missing, and bans any @opensip-tools/graph import.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { dashboardCytoscapeVendorJs } from '../code-paths/cytoscape-vendor.js';
import { dashboardFiltersJs } from '../code-paths/filters.js';
import { dashboardIndexesJs } from '../code-paths/indexes.js';
import { dashboardPathUtilsJs } from '../code-paths/path-utils.js';
import { dashboardSearchJs } from '../code-paths/search.js';
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
    dashboardSearchJs(),
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

// Package-level sample: two packages, one directed edge pkg-a → pkg-b.
const SAMPLE_VM = {
  language: 'typescript',
  nodes: [
    { id: 'pkg-a', label: 'pkg-a', totalCoupling: 3, sccId: null },
    { id: 'pkg-b', label: 'pkg-b', totalCoupling: 3, sccId: null },
  ],
  edges: [{ source: 'pkg-a', target: 'pkg-b', weight: 3, isCycleEdge: false }],
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

describe('View 8 — Visualization', () => {
  it('registers a view with id "graph" and label "Visualization"', () => {
    const env = loadEnv(false);
    const view = env.views.find(v => v.id === 'graph');
    expect(view).toBeDefined();
    expect(view!.label).toBe('Visualization');
    expect(typeof view!.render).toBe('function');
    expect(typeof view!.onActivate).toBe('function');
  });

  it('keeps the view id stable as "graph" for deep-link hashes', () => {
    // The label changed (item 11) but the id must NOT churn.
    expect(dashboardViewGraphJs()).toContain("id: 'graph'");
    expect(dashboardViewGraphJs()).toContain("label: 'Visualization'");
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
    expect(c.querySelector('.empty')!.textContent).toContain('Graph renderer unavailable');
    expect(c.querySelector('#code-paths-graph-canvas')).toBeNull();
  });

  it('renders the layout selector with dagre/cose/breadthfirst', () => {
    const env = loadEnv(true);
    embedViewModel(SAMPLE_VM);
    const c = document.createElement('div');
    document.body.append(c);
    env.views.find(v => v.id === 'graph')!.render(c, null, null, null);
    const btns = [...c.querySelectorAll<HTMLElement>('.code-paths-graph-layout-btn')].map(b => b.dataset.layout);
    expect(btns).toEqual(['dagre', 'cose', 'breadthfirst']);
    expect(c.querySelector<HTMLElement>('.code-paths-graph-layout-btn.active')!.dataset.layout).toBe('dagre');
  });

  it('renders the "Highlight cycles" toggle in the toolbar', () => {
    const env = loadEnv(true);
    embedViewModel(SAMPLE_VM);
    const c = document.createElement('div');
    document.body.append(c);
    env.views.find(v => v.id === 'graph')!.render(c, null, null, null);
    const sccBtn = c.querySelector<HTMLElement>('.code-paths-graph-scc-btn');
    expect(sccBtn).not.toBeNull();
    expect(sccBtn!.textContent).toContain('Highlight cycles');
    expect(sccBtn!.classList.contains('code-paths-graph-layout-btn')).toBe(false);
  });

  it('mounts a cytoscape canvas when the renderer is present', () => {
    const env = loadEnv(true);
    embedViewModel(SAMPLE_VM);
    const c = document.createElement('div');
    document.body.append(c);
    env.views.find(v => v.id === 'graph')!.render(c, null, null, null);
    expect(c.querySelector('#code-paths-graph-canvas')).not.toBeNull();
  });

  it('renders the package-name search box above the canvas', () => {
    const env = loadEnv(true);
    embedViewModel(SAMPLE_VM);
    const c = document.createElement('div');
    document.body.append(c);
    env.views.find(v => v.id === 'graph')!.render(c, null, null, null);
    const input = c.querySelector<HTMLInputElement>('#code-paths-graph-search-input');
    expect(input).not.toBeNull();
    expect(input!.getAttribute('placeholder')).toContain('package');
  });

  it('reuses the shared fuzzyMatch index for search (no separate index)', () => {
    expect(dashboardViewGraphJs()).toContain('fuzzyMatch');
  });

  it('sizes nodes by totalCoupling and edges by weight (package encoding)', () => {
    const js = dashboardViewGraphJs();
    expect(js).toContain("ele.data('totalCoupling')");
    expect(js).toContain("ele.data('weight')");
  });

  it('drives impact highlight off live package adjacency and clears on Esc', () => {
    const js = dashboardViewGraphJs();
    // Package-level impact uses the live cytoscape neighborhood, not the
    // function-level graphIndexes adjacency.
    expect(js).toContain("incomers('node')");
    expect(js).toContain("outgoers('node')");
    expect(js).toContain("e.key === 'Escape'");
  });

  it('does not cull by the function-level filter state (whole-graph package insight)', () => {
    const js = dashboardViewGraphJs();
    expect(js).not.toContain('passesFilter');
    expect(js).not.toContain('No nodes match the active filters');
  });
});
