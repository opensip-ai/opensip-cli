/**
 * View 8 — "Visualization" (node-link topology, Cytoscape.js + dagre).
 *
 * The non-tabular Code Graph view. A self-contained **Level** control switches
 * what the graph shows:
 *
 *  - PACKAGE level (default) — one node per package, one edge per directed
 *    package→package coupling. Source: the pre-projected `graph-view-model`
 *    JSON blob embedded by `generator.ts` — NOT the raw catalog. Absent blob →
 *    empty state.
 *  - FUNCTION level — the functions of ONE selected package and the calls among
 *    them, projected client-side from the embedded catalog indexes by
 *    `gvBuildFunctionElements`. The "Edges" toggle chooses intra-package only
 *    (default) or "+ cross-package". Honors the Scope and Kind filters.
 *
 * The view owns its controls (Level / Scope / Package / Kind / Edges) in
 * `gvRenderControls`; the shared Explore filter chips do NOT govern it. Renderer
 * is the vendored `cytoscape` global + the `cytoscapeDagre` layout extension,
 * both inlined by `dashboardCytoscapeVendorJs()` ahead of this bundle.
 *
 * Features: pan/zoom, layout selector, name search, node-click impact highlight,
 * and cross-package cycle highlighting. Visual encoding lives in
 * `gvStylesheet` / `gvBuildElements` / `gvBuildFunctionElements`.
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`. The view
 * registers itself by pushing into the shared `views` registry at load.
 */

import { el } from './el.js';
import { makeSectionHeading } from './function-row.js';
import { fuzzyMatch } from './search.js';
import { gvBuildFunctionElements, gvRenderControls } from './view-graph-controls.js';
import { gvBuildElements, type GraphElement, type GraphViewModel } from './view-graph-elements.js';
import { GRAPH_VIEW_HELP } from './view-graph-help.js';
import { gvState } from './view-graph-state.js';
import { gvStylesheet } from './view-graph-stylesheet.js';
import { views } from './views-registry.js';

import type { CatalogLike, IndexesLike } from './code-paths-types.js';
import type { CyCollection, CyElement, CyEvent } from './cytoscape-types.js';

// Register the dagre layout extension once. Called LAZILY at first render (not
// at module load) so it does not depend on the vendored `cytoscape` global
// being defined before this bundle — the vendor blob may be inlined after it.
// Guarded so a double-call is harmless.
function gvRegisterGraphLayouts(): void {
  try {
    if (
      typeof cytoscape === 'function' &&
      typeof cytoscapeDagre !== 'undefined' &&
      !cytoscape.__gvDagreRegistered
    ) {
      cytoscape.use(cytoscapeDagre);
      cytoscape.__gvDagreRegistered = true;
    }
  } catch {
    // @swallow-ok extension already registered or unavailable.
  }
}

function gvLoadViewModel(): GraphViewModel | null {
  const blob = document.querySelector('#graph-view-model');
  if (!blob?.textContent) return null;
  try {
    return JSON.parse(blob.textContent) as GraphViewModel;
  } catch {
    // @swallow-ok a malformed embedded blob is treated as "no view-model" — the
    // caller renders the empty state. There is no logger in the browser bundle.
    return null;
  }
}

// The init loop renders EVERY Code Graph panel, not just the active one — the
// row-table views re-render in O(rows), but a full Cytoscape mount + dagre
// layout is far from free. Defer that work until this panel is actually
// visible: the panel orchestrator toggles an 'active' class on the live
// '.code-paths-view' panel. A container that is a panel but not active is
// hidden → skip the mount (it runs on activation). A container that is NOT a
// panel (e.g. a unit-test harness div) is treated as visible so direct
// render() calls mount.
function gvPanelHidden(container: HTMLElement): boolean {
  return !!(
    container?.classList?.contains('code-paths-view') && !container.classList.contains('active')
  );
}

function gvLayoutOptions(layoutId: string): Record<string, unknown> {
  if (layoutId === 'dagre') {
    return { name: 'dagre', rankDir: 'LR', nodeSep: 24, rankSep: 64, fit: true, padding: 24 };
  }
  if (layoutId === 'breadthfirst') {
    return { name: 'breadthfirst', directed: true, spacingFactor: 1.2, fit: true, padding: 24 };
  }
  return { name: 'cose', animate: false, fit: true, padding: 24, nodeRepulsion: 6000 };
}

function gvRunLayout(layoutId: string): void {
  if (!gvState.cy) return;
  gvState.currentLayout = layoutId;
  const layout = gvState.cy.layout(gvLayoutOptions(layoutId));
  layout.run();
}

// Emphasize cross-package cyclic clusters on the live graph. A node is "in a
// cycle" when it carries an sccId; an edge when isCycleEdge is set. Toggling
// off clears the emphasis.
function gvApplySccHighlight(): void {
  const cy = gvState.cy;
  if (!cy) return;
  cy.batch(() => {
    cy.elements().removeClass('gv-scc-member gv-scc-edge gv-scc-dimmed');
    if (!gvState.sccHighlight) return;
    cy.nodes().forEach((n) => {
      if (n.data('sccId')) n.addClass('gv-scc-member');
      else n.addClass('gv-scc-dimmed');
    });
    cy.edges().forEach((ed) => {
      if (ed.data('isCycleEdge')) ed.addClass('gv-scc-edge');
      else ed.addClass('gv-scc-dimmed');
    });
  });
}

function gvClearImpact(): void {
  if (!gvState.cy) return;
  gvState.cy.elements().removeClass('gv-selected gv-upstream gv-downstream gv-dimmed');
}

// Impact highlight at package granularity: light the clicked package, its
// direct caller packages (incomers) and direct callee packages (outgoers).
// Built straight off the live Cytoscape adjacency rather than a function-level
// index, since the nodes ARE packages here.
function gvApplyImpact(seedId: string): void {
  const cy = gvState.cy;
  if (!cy) return;
  // `getElementById` here is the Cytoscape core method (look up a graph node by
  // its data id), NOT the DOM API the prefer-query-selector rule targets.
  // eslint-disable-next-line unicorn/prefer-query-selector -- Cytoscape core API, not the DOM.
  const seed = cy.getElementById(seedId);
  if (!seed || seed.length === 0) return;
  const upstream: Record<string, boolean> = {}; // packages that call the seed
  const downstream: Record<string, boolean> = {}; // packages the seed calls
  seed.incomers('node').forEach((n) => {
    if (n.id() !== seedId) upstream[n.id()] = true;
  });
  seed.outgoers('node').forEach((n) => {
    if (n.id() !== seedId) downstream[n.id()] = true;
  });
  cy.batch(() => {
    cy.elements().removeClass('gv-selected gv-upstream gv-downstream');
    cy.elements().addClass('gv-dimmed');
    cy.nodes().forEach((n) => {
      const id = n.id();
      if (id === seedId) {
        n.removeClass('gv-dimmed').addClass('gv-selected');
      } else if (upstream[id]) {
        n.removeClass('gv-dimmed').addClass('gv-upstream');
      } else if (downstream[id]) {
        n.removeClass('gv-dimmed').addClass('gv-downstream');
      }
    });
    // Un-dim edges incident to the seed so the lit neighborhood reads as
    // connected coupling, not isolated nodes.
    cy.edges().forEach((ed) => {
      const s = ed.source().id();
      const t = ed.target().id();
      if (s === seedId || t === seedId) ed.removeClass('gv-dimmed');
    });
  });
}

// Search box (DOM, above the canvas). Filters by PACKAGE NAME. Reuses the same
// fuzzy index the table views use (fuzzyMatch over the node labels = package
// names). A hit centers + fits the matched node and flags it; non-matches
// fade. Clearing restores opacity.
function gvRenderSearchBox(host: HTMLElement): void {
  const input = el('input', {
    type: 'search',
    class: 'search-input code-paths-graph-search',
    id: 'code-paths-graph-search-input',
    // Labels are package names at package level, function names at function
    // level; the search matches whatever the live node labels are.
    placeholder:
      gvState.level === 'function' ? 'Find a function by name…' : 'Find a package by name…',
  });
  input.addEventListener('input', (e) => {
    gvApplySearch((e.target as HTMLInputElement).value ?? '');
  });
  host.append(input);
}

function gvApplySearch(query: string): void {
  const cy = gvState.cy;
  if (!cy) return;
  const q = (query ?? '').trim();
  cy.nodes().removeClass('gv-search-hit gv-search-fade');
  if (q.length === 0) return;
  // The view-model label is the package name; match against it directly
  // (the fuzzy scorer lives in search.ts, bundled earlier).
  const labels = cy.nodes().map((n) => (n.data('label') as string) ?? '');
  const matches = fuzzyMatch(q, labels);
  const hitLabels: Record<string, boolean> = {};
  for (const m of matches) hitLabels[m.name] = true;
  let hitCollection: CyCollection = cy.collection();
  cy.nodes().forEach((n) => {
    if (hitLabels[n.data('label') as string]) {
      n.addClass('gv-search-hit');
      hitCollection = hitCollection.union(n);
    } else {
      n.addClass('gv-search-fade');
    }
  });
  if (hitCollection.length > 0) {
    try {
      cy.center(hitCollection);
      cy.fit(hitCollection, 120);
    } catch {
      // @swallow-ok fit/center best-effort.
    }
  }
}

// Append the `.empty` placeholder for a given message and return null — a
// terse helper so the element-resolution branches read as guard clauses.
function gvEmpty(container: HTMLElement, text: string): null {
  container.append(el('div', { class: 'empty', text }));
  return null;
}

// Resolve the Cytoscape elements for the current Level, or append an empty-state
// and return null. Package level keeps the historical empty-state ORDER
// (view-model check before the cytoscape check) so the structural tests stay
// valid.
function gvResolveElements(container: HTMLElement, indexes: IndexesLike): GraphElement[] | null {
  if (gvState.level === 'function') {
    if (typeof cytoscape !== 'function') return gvEmpty(container, 'Graph renderer unavailable.');
    if (!gvState.selectedPackage) {
      return gvEmpty(container, 'Select a package to view its functions.');
    }
    const elements = gvBuildFunctionElements(
      indexes,
      gvState.selectedPackage,
      gvState.includeTests,
      gvState.kinds,
      gvState.crossPackage,
    );
    if (!elements || elements.length === 0) {
      return gvEmpty(container, 'No functions in this package.');
    }
    return elements;
  }
  const vm = gvLoadViewModel();
  if (!vm?.nodes || vm.nodes.length === 0) return gvEmpty(container, 'No graph to display.');
  if (typeof cytoscape !== 'function') return gvEmpty(container, 'Graph renderer unavailable.');
  const elements = gvBuildElements(vm);
  if (elements.length === 0) return gvEmpty(container, 'No packages to display.');
  return elements;
}

// Mount the Cytoscape canvas with the resolved elements. Returns true on a
// successful mount (gvState.cy set), false if the renderer could not initialize
// (e.g. a headless test runner without a real 2D canvas) — in which case the
// rest of the page stays usable.
function gvMountCanvas(container: HTMLElement, elements: GraphElement[]): boolean {
  const canvas = el('div', { class: 'code-paths-graph-canvas', id: 'code-paths-graph-canvas' });
  container.append(canvas);
  try {
    gvState.cy = cytoscape({
      container: canvas,
      elements,
      style: gvStylesheet(),
      layout: gvLayoutOptions(gvState.currentLayout),
      wheelSensitivity: 0.2,
      minZoom: 0.05,
      maxZoom: 4,
    });
  } catch {
    // @swallow-ok cytoscape mounting throws in environments without a real 2D
    // canvas (e.g. headless test runners); fail soft with an inline notice so the
    // rest of the page stays usable. No browser-bundle logger to record it.
    gvState.cy = null;
    canvas.append(
      el('div', {
        class: 'empty',
        text: 'Graph renderer could not initialize in this environment.',
      }),
    );
    return false;
  }
  return true;
}

// Wire node-click impact highlight + background/Escape clear onto the live graph.
// Replaces (does not stack) the document keydown listener across re-renders.
function gvWireInteractions(): void {
  const cy = gvState.cy;
  if (!cy) return;
  cy.on('tap', 'node', (evt: CyEvent) => {
    gvApplyImpact((evt.target as CyElement).id());
  });
  cy.on('tap', (evt: CyEvent) => {
    if (evt.target === cy) gvClearImpact();
  });
  if (gvState.escHandler) {
    try {
      document.removeEventListener('keydown', gvState.escHandler);
    } catch {
      // @swallow-ok listener removal best-effort.
    }
  }
  gvState.escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') gvClearImpact();
  };
  document.addEventListener('keydown', gvState.escHandler);
}

// The actual render driver — called by the view's render() AND by every
// control-change handler (so a control change re-renders in place).
function gvRenderGraph(
  container: HTMLElement,
  catalog: CatalogLike | null,
  indexes: IndexesLike,
): void {
  while (container.firstChild) container.firstChild.remove();
  // Defer the expensive mount while this panel is hidden (see gvPanelHidden).
  // activateView() re-renders the panel once it becomes visible.
  if (gvPanelHidden(container)) return;

  // Register the dagre layout on first render (the vendored cytoscape global is
  // present by render time even if it was inlined after this bundle).
  gvRegisterGraphLayouts();

  // Section heading + ⓘ help button, consistent with the Coupling and Functions
  // views (makeSectionHeading wires the button to openHelpDrawer for this view's
  // id, which surfaces the 'graph' view's help sections).
  container.append(makeSectionHeading('Visualization', 'graph'));
  // The control grid includes the search box and the Highlight-cycles toggle.
  // Inject this view's render handlers so the controls module never imports back
  // into view-graph (one-directional dependency, no module cycle).
  gvRenderControls(container, catalog, indexes, {
    rerender: () => gvRenderGraph(container, catalog, indexes),
    runLayout: gvRunLayout,
    applySccHighlight: gvApplySccHighlight,
    renderSearchBox: gvRenderSearchBox,
  });

  const elements = gvResolveElements(container, indexes);
  if (!elements) return;
  if (!gvMountCanvas(container, elements)) return;
  gvWireInteractions();

  // Re-apply the cycle emphasis if the toggle was left on across a re-render.
  gvApplySccHighlight();
}

views.push({
  id: 'graph',
  label: 'Visualization',
  help: GRAPH_VIEW_HELP,
  render(container, catalog, indexes) {
    // The shared Explore filterState is intentionally NOT consulted here — this
    // view owns its own controls (gvRenderControls). All rendering lives in
    // gvRenderGraph so control-change handlers can re-render in place.
    gvRenderGraph(container, catalog, indexes);
  },
  onActivate() {
    // The canvas needs a measured size before fit() — defer one frame so the
    // container has finished switching from display:none to block.
    if (!gvState.cy) return;
    setTimeout(() => {
      try {
        gvState.cy?.resize();
        gvState.cy?.fit(undefined, 24);
      } catch {
        // @swallow-ok resize/fit best-effort.
      }
    }, 0);
  },
});
