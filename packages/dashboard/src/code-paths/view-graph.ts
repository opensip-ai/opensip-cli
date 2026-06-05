/**
 * View 8 — "Visualization" (node-link topology, Cytoscape.js + dagre).
 *
 * The non-tabular Code Graph view. A self-contained **Level** control switches
 * what the graph shows:
 *
 *  - PACKAGE level (default) — one node per package, one edge per directed
 *    package→package coupling. Function granularity across the whole repo
 *    produced thousands of nodes, unusable in a node-link layout; the package
 *    rollup is the same data the Coupling matrix shows, drawn as a graph.
 *    Source: the pre-projected `graph-view-model` JSON blob embedded by
 *    `generator.ts` (projector in `graph-view-model.ts`, run at
 *    report-generation time) — NOT the raw catalog. Absent blob → empty state.
 *  - FUNCTION level — the functions of ONE selected package and the calls
 *    among them, projected client-side from the embedded catalog indexes by
 *    `gvBuildFunctionElements`. Scoping to a single package keeps the node
 *    count bounded. The "Edges" toggle chooses intra-package only (default) or
 *    "+ cross-package" (also draw calls leaving the package, to faded external
 *    nodes). Honors the Scope (test inclusion) and Kind (multi-select) filters.
 *
 * The view owns its controls (Level / Scope / Package / Kind / Edges) in
 * `gvRenderControls`; the shared Explore filter chips govern the Functions
 * table, NOT this view. Package + Kind only apply at function level, so they
 * are disabled at package level. Renderer is the vendored `cytoscape` global +
 * the `cytoscapeDagre` layout extension, both inlined by
 * `dashboardCytoscapeVendorJs()` ahead of this emitter in `code-paths.ts`.
 *
 * Features: pan/zoom, layout selector (dagre/cose/breadthfirst), name search,
 * node-click impact highlight (direct caller/callee neighbors), and
 * cross-package cycle highlighting (package level). Visual encoding
 * (totalCoupling→size, weight→edge thickness, sccId→accent, external→faded) is
 * applied in `gvStylesheet` / `gvBuildElements` / `gvBuildFunctionElements`.
 */

import { dashboardGraphControlsJs } from './graph-controls.js';
import { dashboardViewGraphStylesheetJs } from './graph-stylesheet.js';

// @graph-ignore-next-line graph:large-function -- emits one cohesive browser-JS bundle as a String.raw template; bodyLines counts the embedded JS-as-string, not splittable logic (ADR-0014)
export function dashboardViewGraphJs(): string {
  return String.raw`
// Register the dagre layout extension once (the vendored globals are
// declared earlier in the bundle). Guarded so a double-load is harmless.
(function registerGraphLayouts() {
  try {
    if (typeof cytoscape === 'function' && typeof cytoscapeDagre !== 'undefined' && !cytoscape.__gvDagreRegistered) {
      cytoscape.use(cytoscapeDagre);
      cytoscape.__gvDagreRegistered = true;
    }
  } catch (e) { /* extension already registered or unavailable */ }
})();

// Available layouts. dagre is the default for mostly-DAG package graphs; cose
// (built-in force-directed) reads better when cycles dominate;
// breadthfirst is a cheap hierarchical fallback. No fcose — it needs a
// fourth vendored extension and the bundle budget is tight.
var GV_LAYOUTS = [
  { id: 'dagre', label: 'Dagre (layered)' },
  { id: 'cose', label: 'Cose (force)' },
  { id: 'breadthfirst', label: 'Breadthfirst' },
];
var gvCurrentLayout = 'dagre';
var gvCy = null;

// ---- Visualization control state (self-contained; NOT the shared Explore
// filter bar). These live in module vars so they survive the in-place
// re-render each control change triggers (gvRenderGraph). ----
//   gvLevel            'package' (default) → package→package rollup blob.
//                      'function'          → the selected package's functions.
//   gvIncludeTests     Scope dropdown: false = production only (default).
//   gvSelectedPackage  single package chosen at function level (null = none).
//   gvKinds            multi-selected function kinds ([] = all).
//   gvCrossPackage     function-level "Edges" toggle: false = intra-package
//                      (default), true = also draw edges leaving the package
//                      to faded external function nodes.
var gvLevel = 'package';
var gvIncludeTests = false;
var gvSelectedPackage = null;
var gvKinds = [];
var gvCrossPackage = false;
// The active Escape handler, tracked so each re-render replaces (not stacks)
// its document-level keydown listener.
var gvEscHandler = null;

function gvLoadViewModel() {
  var blob = document.getElementById('graph-view-model');
  if (!blob || !blob.textContent) return null;
  try { return JSON.parse(blob.textContent); } catch (e) { return null; }
}

// The init loop renders EVERY Code Graph panel, not just the active one — the
// row-table views re-render in O(rows), but a full Cytoscape mount + dagre
// layout is far from free. Defer that work until this panel is actually
// visible: the panel orchestrator toggles an 'active' class on the live
// '.code-paths-view' panel. A container that is a panel but not active is
// hidden → skip the mount (it runs on activation). A container that is NOT a
// panel (e.g. a unit-test harness div) is treated as visible so direct
// render() calls mount.
function gvPanelHidden(container) {
  return !!(container && container.classList &&
    container.classList.contains('code-paths-view') &&
    !container.classList.contains('active'));
}

// Map a sccId to a stable hue so cross-package cyclic clusters are grouped.
function gvSccColor(sccId) {
  if (!sccId) return null;
  var h = 0;
  for (var i = 0; i < sccId.length; i++) { h = (h * 31 + sccId.charCodeAt(i)) % 360; }
  return 'hsl(' + h + ', 70%, 55%)';
}

function gvBuildElements(vm) {
  var elements = [];
  for (var i = 0; i < vm.nodes.length; i++) {
    var n = vm.nodes[i];
    elements.push({
      group: 'nodes',
      data: {
        id: n.id,
        label: n.label,
        totalCoupling: n.totalCoupling || 0,
        sccId: n.sccId || null,
        sccColor: gvSccColor(n.sccId),
      },
    });
  }
  for (var j = 0; j < vm.edges.length; j++) {
    var e = vm.edges[j];
    elements.push({
      group: 'edges',
      data: {
        id: 'e' + j,
        source: e.source,
        target: e.target,
        weight: e.weight || 1,
        isCycleEdge: !!e.isCycleEdge,
      },
    });
  }
  return elements;
}

${dashboardViewGraphStylesheetJs()}

function gvLayoutOptions(layoutId) {
  if (layoutId === 'dagre') {
    return { name: 'dagre', rankDir: 'LR', nodeSep: 24, rankSep: 64, fit: true, padding: 24 };
  }
  if (layoutId === 'breadthfirst') {
    return { name: 'breadthfirst', directed: true, spacingFactor: 1.2, fit: true, padding: 24 };
  }
  return { name: 'cose', animate: false, fit: true, padding: 24, nodeRepulsion: 6000 };
}

function gvRunLayout(layoutId) {
  if (!gvCy) return;
  gvCurrentLayout = layoutId;
  var layout = gvCy.layout(gvLayoutOptions(layoutId));
  layout.run();
}

// The Layout selector and the "Highlight cycles" toggle now live in the single
// control toolbar built by gvRenderControls (graph-controls.ts) — Layout as a
// dropdown matching the other controls. gvRunLayout / gvSccHighlight /
// gvApplySccHighlight (below) are the shared handlers those controls call.

// Emphasize cross-package cyclic clusters on the live graph. A node is "in a
// cycle" when it carries an sccId; an edge when isCycleEdge is set. Toggling
// off clears the emphasis.
var gvSccHighlight = false;

function gvApplySccHighlight() {
  if (!gvCy) return;
  gvCy.batch(function() {
    gvCy.elements().removeClass('gv-scc-member gv-scc-edge gv-scc-dimmed');
    if (!gvSccHighlight) return;
    gvCy.nodes().forEach(function(n) {
      if (n.data('sccId')) n.addClass('gv-scc-member');
      else n.addClass('gv-scc-dimmed');
    });
    gvCy.edges().forEach(function(ed) {
      if (ed.data('isCycleEdge')) ed.addClass('gv-scc-edge');
      else ed.addClass('gv-scc-dimmed');
    });
  });
}

function gvClearImpact() {
  if (!gvCy) return;
  gvCy.elements().removeClass('gv-selected gv-upstream gv-downstream gv-dimmed');
}

// Impact highlight at package granularity: light the clicked package, its
// direct caller packages (incomers) and direct callee packages (outgoers).
// Built straight off the live Cytoscape adjacency rather than a function-level
// index, since the nodes ARE packages here.
function gvApplyImpact(seedId) {
  if (!gvCy) return;
  var seed = gvCy.getElementById(seedId);
  if (!seed || seed.length === 0) return;
  var upstream = {};   // packages that call the seed
  var downstream = {}; // packages the seed calls
  seed.incomers('node').forEach(function(n) { if (n.id() !== seedId) upstream[n.id()] = true; });
  seed.outgoers('node').forEach(function(n) { if (n.id() !== seedId) downstream[n.id()] = true; });
  gvCy.batch(function() {
    gvCy.elements().removeClass('gv-selected gv-upstream gv-downstream');
    gvCy.elements().addClass('gv-dimmed');
    gvCy.nodes().forEach(function(n) {
      var id = n.id();
      if (id === seedId) { n.removeClass('gv-dimmed').addClass('gv-selected'); }
      else if (upstream[id]) { n.removeClass('gv-dimmed').addClass('gv-upstream'); }
      else if (downstream[id]) { n.removeClass('gv-dimmed').addClass('gv-downstream'); }
    });
    // Un-dim edges incident to the seed so the lit neighborhood reads as
    // connected coupling, not isolated nodes.
    gvCy.edges().forEach(function(ed) {
      var s = ed.source().id();
      var t = ed.target().id();
      if (s === seedId || t === seedId) ed.removeClass('gv-dimmed');
    });
  });
}

// Search box (DOM, above the canvas). Filters by PACKAGE NAME. Reuses the same
// fuzzy index the table views use (fuzzyMatch over the node labels = package
// names). A hit centers + fits the matched node and flags it; non-matches
// fade. Clearing restores opacity.
function gvRenderSearchBox(host) {
  var input = el('input', {
    type: 'search',
    class: 'search-input code-paths-graph-search',
    id: 'code-paths-graph-search-input',
    // Labels are package names at package level, function names at function
    // level; the search matches whatever the live node labels are.
    placeholder: gvLevel === 'function' ? 'Find a function by name…' : 'Find a package by name…',
  });
  input.addEventListener('input', function(e) {
    gvApplySearch((e.target && e.target.value) || '');
  });
  host.appendChild(input);
}

function gvApplySearch(query) {
  if (!gvCy) return;
  var q = (query || '').trim();
  gvCy.nodes().removeClass('gv-search-hit gv-search-fade');
  if (q.length === 0) return;
  // The view-model label is the package name; match against it directly
  // (the fuzzy scorer lives in search.js, emitted earlier in the bundle).
  var labels = gvCy.nodes().map(function(n) { return n.data('label') || ''; });
  var matches = (typeof fuzzyMatch === 'function') ? fuzzyMatch(q, labels) : [];
  var hitLabels = {};
  for (var i = 0; i < matches.length; i++) hitLabels[matches[i].name] = true;
  var hitCollection = gvCy.collection();
  gvCy.nodes().forEach(function(n) {
    if (hitLabels[n.data('label')]) { n.addClass('gv-search-hit'); hitCollection = hitCollection.union(n); }
    else { n.addClass('gv-search-fade'); }
  });
  if (hitCollection.length > 0) {
    try { gvCy.center(hitCollection); gvCy.fit(hitCollection, 120); } catch (e) { /* ignore */ }
  }
}

${dashboardGraphControlsJs()}

// The actual render driver — called by the view's render() AND by every
// control-change handler (so a control change re-renders in place). Mirrors
// the old render() but branches on gvLevel for the element source. Package
// level keeps the historical empty-state ORDER (view-model check before the
// cytoscape check) so the structural view tests stay valid.
function gvRenderGraph(container, catalog, indexes) {
  while (container.firstChild) container.removeChild(container.firstChild);
  // Defer the expensive mount while this panel is hidden (see gvPanelHidden).
  // activateView() re-renders the panel once it becomes visible.
  if (gvPanelHidden(container)) return;

  // Section heading + ⓘ help button, consistent with the Coupling and
  // Functions views (makeSectionHeading wires the button to openHelpDrawer for
  // this view's id, which surfaces the 'graph' view's help sections).
  container.appendChild(makeSectionHeading('Visualization', 'graph'));
  // The control grid includes the search box and the Highlight-cycles toggle
  // (row 1, cols 3-4), so there's nothing else to render here.
  gvRenderControls(container, catalog, indexes);

  var elements;
  if (gvLevel === 'function') {
    if (typeof cytoscape !== 'function') {
      container.appendChild(el('div', { class: 'empty', text: 'Graph renderer unavailable.' }));
      return;
    }
    if (!gvSelectedPackage) {
      container.appendChild(el('div', { class: 'empty', text: 'Select a package to view its functions.' }));
      return;
    }
    elements = gvBuildFunctionElements(indexes, gvSelectedPackage, gvIncludeTests, gvKinds, gvCrossPackage);
    if (!elements || elements.length === 0) {
      container.appendChild(el('div', { class: 'empty', text: 'No functions in this package.' }));
      return;
    }
  } else {
    var vm = gvLoadViewModel();
    if (!vm || !vm.nodes || vm.nodes.length === 0) {
      container.appendChild(el('div', { class: 'empty', text: 'No graph to display.' }));
      return;
    }
    if (typeof cytoscape !== 'function') {
      container.appendChild(el('div', { class: 'empty', text: 'Graph renderer unavailable.' }));
      return;
    }
    elements = gvBuildElements(vm);
    if (elements.length === 0) {
      container.appendChild(el('div', { class: 'empty', text: 'No packages to display.' }));
      return;
    }
  }

  var canvas = el('div', { class: 'code-paths-graph-canvas', id: 'code-paths-graph-canvas' });
  container.appendChild(canvas);

  // Mounting can throw in environments without a real 2D canvas (e.g. headless
  // test runners). Fail soft — the rest of the page stays usable.
  try {
    gvCy = cytoscape({
      container: canvas,
      elements: elements,
      style: gvStylesheet(),
      layout: gvLayoutOptions(gvCurrentLayout),
      wheelSensitivity: 0.2,
      minZoom: 0.05,
      maxZoom: 4,
    });
  } catch (e) {
    gvCy = null;
    canvas.appendChild(el('div', { class: 'empty', text: 'Graph renderer could not initialize in this environment.' }));
    return;
  }

  // Click a node → highlight its direct caller/callee neighbors. Background
  // click or Esc clears. Replace (don't stack) the document keydown listener.
  gvCy.on('tap', 'node', function(evt) { gvApplyImpact(evt.target.id()); });
  gvCy.on('tap', function(evt) { if (evt.target === gvCy) gvClearImpact(); });
  if (gvEscHandler) { try { document.removeEventListener('keydown', gvEscHandler); } catch (e) { /* ignore */ } }
  gvEscHandler = function(e) { if (e.key === 'Escape') gvClearImpact(); };
  document.addEventListener('keydown', gvEscHandler);

  // Re-apply the cycle emphasis if the toggle was left on across a re-render.
  gvApplySccHighlight();
}

views.push({
  id: 'graph',
  label: 'Visualization',
  help: {
    title: 'Visualization',
    sections: [
      { heading: 'What this is', body: 'A node-link visualization of the call graph, rendered with Cytoscape.js. At Package level each node is a package and each edge is the directed coupling from one package into another; node size reflects total coupling (calls in + calls out) and edge thickness reflects the number of call edges. At Function level it shows the functions of one selected package and the calls among them.' },
      { heading: 'Levels', body: 'Use the Level control to switch between Package (the whole-repo package rollup, the same data as the Coupling matrix) and Function (one package at a time). Function level enables the Package picker (which package to show) and the Kind multi-select, plus an Edges toggle: "Intra-package" shows only calls inside the package; "+ cross-package" also draws calls leaving the package to faded external nodes. The Scope control (production only vs include tests) applies at both levels.' },
      { heading: 'Why you care', body: 'The table views project the graph into rankings and lists, and the Coupling matrix shows the same package data as a grid. This view shows that topology directly — hub packages, tightly-coupled clusters, and circular package dependencies at package level; the internal call structure of a single package at function level.' },
      { heading: 'How to read it', body: 'Bigger nodes are more coupled; thicker edges carry more calls. Use the layout selector to switch between layered (dagre), force (cose), and hierarchical (breadthfirst). The matrix on the Coupling tab is the package-level data in tabular form.' },
      { heading: 'What to do', body: 'Pan and zoom to explore. Type in the search box to center and highlight a node by name; non-matches fade. Click a node to trace its direct callers (upstream) and callees (downstream).' },
      { heading: 'Cross-package cycles', body: 'Strongly-connected components are groups of packages that can all reach each other through call edges (found via Tarjan’s algorithm). Click "Highlight cycles" in the toolbar to emphasize cycle members and cycle edges while dimming the acyclic remainder. A cycle between packages is usually a layering smell. Break it by extracting the shared protocol into a third package both sides depend on, or by inverting one call into a callback/event.' },
    ],
  },
  render(container, catalog, indexes, filterState) {
    // The shared Explore filterState is intentionally NOT consulted here — this
    // view owns its own controls (gvRenderControls). All rendering lives in
    // gvRenderGraph so control-change handlers can re-render in place.
    gvRenderGraph(container, catalog, indexes);
  },
  onActivate() {
    // The canvas needs a measured size before fit() — defer one frame so
    // the container has finished switching from display:none to block.
    if (!gvCy) return;
    setTimeout(function() {
      try { gvCy.resize(); gvCy.fit(undefined, 24); } catch (e) { /* ignore */ }
    }, 0);
  },
});
`;
}
