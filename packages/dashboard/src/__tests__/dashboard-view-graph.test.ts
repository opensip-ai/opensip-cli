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
import { dashboardFunctionRowJs } from '../code-paths/function-row.js';
import { dashboardHelpDrawerJs } from '../code-paths/help-drawer.js';
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
    dashboardFunctionRowJs(), // declares makeSectionHeading (the ⓘ heading helper)
    dashboardHelpDrawerJs(), // declares openHelpDrawer (so the ⓘ button renders)
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
    const view = env.views.find((v) => v.id === 'graph');
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
    env.views.find((v) => v.id === 'graph')!.render(c, null, null, null);
    expect(c.querySelector('.empty')).not.toBeNull();
    expect(c.querySelector('.empty')!.textContent).toContain('No graph to display');
  });

  it('renders the renderer-unavailable state when cytoscape is missing', () => {
    const env = loadEnv(false); // no vendor → no cytoscape global
    embedViewModel(SAMPLE_VM);
    const c = document.createElement('div');
    document.body.append(c);
    env.views.find((v) => v.id === 'graph')!.render(c, null, null, null);
    expect(c.querySelector('.empty')!.textContent).toContain('Graph renderer unavailable');
    expect(c.querySelector('#code-paths-graph-canvas')).toBeNull();
  });

  it('renders the layout selector as a dropdown with dagre/cose/breadthfirst', () => {
    const env = loadEnv(true);
    embedViewModel(SAMPLE_VM);
    const c = document.createElement('div');
    document.body.append(c);
    env.views.find((v) => v.id === 'graph')!.render(c, null, null, null);
    const layout = c.querySelector<HTMLSelectElement>('select[data-control="layout"]');
    expect(layout).not.toBeNull();
    expect([...layout!.options].map((o) => o.value)).toEqual(['dagre', 'cose', 'breadthfirst']);
    expect(layout!.value).toBe('dagre'); // default
  });

  it('renders a section heading with an ⓘ help button (consistent with Coupling/Functions)', () => {
    const env = loadEnv(true);
    embedViewModel(SAMPLE_VM);
    const c = document.createElement('div');
    document.body.append(c);
    env.views.find((v) => v.id === 'graph')!.render(c, null, null, null);
    const heading = c.querySelector('h3');
    expect(heading).not.toBeNull();
    expect(heading!.textContent).toContain('Visualization');
    const info = c.querySelector('.section-info');
    expect(info).not.toBeNull();
  });

  it('renders the "Highlight cycles" toggle as a checkbox in the control toolbar', () => {
    const env = loadEnv(true);
    embedViewModel(SAMPLE_VM);
    const c = document.createElement('div');
    document.body.append(c);
    env.views.find((v) => v.id === 'graph')!.render(c, null, null, null);
    const sccCb = c.querySelector<HTMLInputElement>('input[type="checkbox"][data-scc-toggle]');
    expect(sccCb).not.toBeNull();
    const lbl = c.querySelector<HTMLElement>('.code-paths-graph-checkbox');
    expect(lbl).not.toBeNull();
    expect(lbl!.textContent).toContain('Highlight cycles');
  });

  it('mounts a cytoscape canvas when the renderer is present', () => {
    const env = loadEnv(true);
    embedViewModel(SAMPLE_VM);
    const c = document.createElement('div');
    document.body.append(c);
    env.views.find((v) => v.id === 'graph')!.render(c, null, null, null);
    expect(c.querySelector('#code-paths-graph-canvas')).not.toBeNull();
  });

  it('renders the package-name search box above the canvas', () => {
    const env = loadEnv(true);
    embedViewModel(SAMPLE_VM);
    const c = document.createElement('div');
    document.body.append(c);
    env.views.find((v) => v.id === 'graph')!.render(c, null, null, null);
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

  it('does not consult the shared Explore filterState (the view owns its controls)', () => {
    const js = dashboardViewGraphJs();
    // The view never calls the shared passesFilter; package level is whole-graph
    // and function level applies its OWN Scope/Kind filter inside the projector.
    expect(js).not.toContain('passesFilter');
    expect(js).not.toContain('No nodes match the active filters');
  });

  it('renders Level/Scope/Package/Kind/Edges, with Package, Kind & Edges disabled (not hidden) at package level', () => {
    const env = loadEnv(true);
    embedViewModel(SAMPLE_VM);
    const c = document.createElement('div');
    document.body.append(c);
    env.views.find((v) => v.id === 'graph')!.render(c, null, null, null);
    const level = c.querySelector<HTMLSelectElement>('select[data-control="level"]');
    const scope = c.querySelector<HTMLSelectElement>('select[data-control="scope"]');
    const pkg = c.querySelector<HTMLSelectElement>('select[data-control="package"]');
    // Kind is a custom multi-select dropdown (trigger button + checkbox panel),
    // not a native <select multiple>.
    const kind = c.querySelector<HTMLButtonElement>('button[data-control="kind"]');
    const edges = c.querySelector<HTMLSelectElement>('select[data-control="granularity"]');
    expect(level).not.toBeNull();
    expect(scope).not.toBeNull();
    expect(level!.value).toBe('package'); // default
    expect(kind).not.toBeNull();
    expect(kind!.classList.contains('code-paths-graph-ms-trigger')).toBe(true);
    // Edges is now ALWAYS rendered (was hidden until function level).
    expect(edges).not.toBeNull();
    // Package, Kind & Edges only apply at function level → disabled (greyed),
    // not hidden, at package level — consistent across the three.
    expect(pkg!.disabled).toBe(true);
    expect(kind!.disabled).toBe(true);
    expect(edges!.disabled).toBe(true);
  });

  it('Kind multi-select enables at function level and updates the graph on close', () => {
    const occA = {
      bodyHash: 'A',
      simpleName: 'a',
      filePath: 'packages/pkg-a/src/a.ts',
      kind: 'function-declaration',
      inTestFile: false,
      qualifiedName: 'a',
    };
    const occB = {
      bodyHash: 'B',
      simpleName: 'b',
      filePath: 'packages/pkg-a/src/b.ts',
      kind: 'method',
      inTestFile: false,
      qualifiedName: 'b',
    };
    const indexes = {
      byBodyHash: new Map<string, unknown>([
        ['A', occA],
        ['B', occB],
      ]),
      occurrencesByHash: new Map<string, unknown[]>([
        ['A', [occA]],
        ['B', [occB]],
      ]),
      bySimpleName: new Map(),
      callees: new Map<string, string[]>([['A', ['B']]]),
      callers: new Map<string, string[]>([['B', ['A']]]),
    };
    const catalog = {
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: { a: [occA], b: [occB] },
    };
    const env = loadEnv(true);
    const c = document.createElement('div');
    document.body.append(c);
    env.views.find((v) => v.id === 'graph')!.render(c, catalog, indexes, null);

    // Switch to function level + pick pkg-a so Kind becomes enabled.
    const level = c.querySelector<HTMLSelectElement>('select[data-control="level"]')!;
    level.value = 'function';
    level.dispatchEvent(new Event('change'));
    const pkg = c.querySelector<HTMLSelectElement>('select[data-control="package"]')!;
    pkg.value = 'pkg-a';
    pkg.dispatchEvent(new Event('change'));

    const kindTrigger = c.querySelector<HTMLButtonElement>('button[data-control="kind"]')!;
    expect(kindTrigger.disabled).toBe(false);
    expect(kindTrigger.textContent).toContain('All kinds');
    // Open the popover, check one kind, close → graph re-renders, canvas present.
    kindTrigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const boxes = c.querySelectorAll<HTMLInputElement>(
      '.code-paths-graph-ms-panel input[type="checkbox"]',
    );
    expect(boxes.length).toBeGreaterThan(0);
    boxes[0].checked = true;
    boxes[0].dispatchEvent(new Event('change'));
    // Closing (re-click) applies the selection and re-renders.
    c.querySelector<HTMLButtonElement>('button[data-control="kind"]')!.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    expect(c.querySelector('#code-paths-graph-canvas')).not.toBeNull();
  });

  it("projects a single package's function graph at function level (intra-package)", () => {
    // Two functions in pkg-a, a → b. Switching to function level + selecting
    // pkg-a should project them into a Cytoscape canvas (intra-package default).
    const occA = {
      bodyHash: 'A',
      simpleName: 'a',
      filePath: 'packages/pkg-a/src/a.ts',
      kind: 'function-declaration',
      inTestFile: false,
      qualifiedName: 'a',
    };
    const occB = {
      bodyHash: 'B',
      simpleName: 'b',
      filePath: 'packages/pkg-a/src/b.ts',
      kind: 'function-declaration',
      inTestFile: false,
      qualifiedName: 'b',
    };
    const indexes = {
      byBodyHash: new Map<string, unknown>([
        ['A', occA],
        ['B', occB],
      ]),
      occurrencesByHash: new Map<string, unknown[]>([
        ['A', [occA]],
        ['B', [occB]],
      ]),
      bySimpleName: new Map(),
      callees: new Map<string, string[]>([['A', ['B']]]),
      callers: new Map<string, string[]>([['B', ['A']]]),
    };
    const catalog = {
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: { a: [occA], b: [occB] },
    };

    const env = loadEnv(true);
    const c = document.createElement('div');
    document.body.append(c);
    env.views.find((v) => v.id === 'graph')!.render(c, catalog, indexes, null);

    // Switch Level → function (re-renders in place via the change handler).
    const level = c.querySelector<HTMLSelectElement>('[data-control="level"]')!;
    level.value = 'function';
    level.dispatchEvent(new Event('change'));
    // Before a package is chosen, the view prompts for one (no canvas yet).
    expect(c.querySelector('#code-paths-graph-canvas')).toBeNull();
    expect(c.querySelector('.empty')!.textContent).toContain('Select a package');

    // Choose pkg-a → the function graph projects and the canvas mounts.
    const pkg = c.querySelector<HTMLSelectElement>('[data-control="package"]')!;
    expect([...pkg.options].map((o) => o.value)).toContain('pkg-a');
    pkg.value = 'pkg-a';
    pkg.dispatchEvent(new Event('change'));
    expect(c.querySelector('#code-paths-graph-canvas')).not.toBeNull();
    // The Edges (intra vs cross-package) toggle appears only at function level.
    expect(c.querySelector('[data-control="granularity"]')).not.toBeNull();
  });
});
