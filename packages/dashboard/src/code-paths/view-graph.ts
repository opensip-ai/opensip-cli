/**
 * View 8 — "Graph" (node-link topology, Cytoscape.js + dagre).
 *
 * The first non-tabular Code Paths view: it renders the *shape* of the
 * call graph rather than another projection of it. The renderer is the
 * vendored Cytoscape global (`cytoscape`) plus the `cytoscapeDagre` layout
 * extension, both inlined by `dashboardCytoscapeVendorJs()` ahead of this
 * emitter in `code-paths.ts`.
 *
 * Data source: the pre-projected `graph-view-model` JSON blob embedded by
 * `generator.ts` (NOT the raw catalog). The projector lives in
 * `graph-view-model.ts` and runs at report-generation time; the view reads
 * the slim result. If the blob is absent (older report, no catalog), the
 * view shows an empty state.
 *
 * Phase 3 scope: pan / zoom / node-click selection + a layout selector
 * (dagre default, with cose and breadthfirst alternates — all available
 * without an extra extension; cose handles cyclic clusters dagre renders
 * awkwardly). Filter, search, and impact highlight are layered on by later
 * phases.
 *
 * Visual encoding (Phase 0 §4 field-to-consumer map):
 *   - node shape    ← kind        (constructor=diamond, method/getter/setter=round-rectangle, …)
 *   - node stroke   ← visibility  (private=dashed, module-local=dotted, exported=solid)
 *   - node size     ← callDegreeIn + callDegreeOut
 *   - node group    ← sccId       (cyclic clusters get a shared accent border)
 *   - edge style    ← resolution  (static=solid, method-dispatch=dashed, dynamic-string=dotted)
 *   - edge opacity  ← confidence  (low=faded)
 */

import { dashboardViewGraphStylesheetJs } from './graph-stylesheet.js';

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

// Available layouts. dagre is the default for mostly-DAG code graphs; cose
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

function gvLoadViewModel() {
  var blob = document.getElementById('graph-view-model');
  if (!blob || !blob.textContent) return null;
  try { return JSON.parse(blob.textContent); } catch (e) { return null; }
}

// notifyViews() (and the init loop) fan render() out to EVERY Code Paths
// panel, not just the active one — the row-table views re-render in O(rows),
// but a full Cytoscape mount + dagre layout over thousands of nodes is far
// from free. Defer that work until this panel is actually visible: the panel
// orchestrator toggles an 'active' class on the live '.code-paths-view'
// panel. A container that is a panel but not active is hidden → skip the
// mount (it runs on activation). A container that is NOT a panel (e.g. a
// unit-test harness div) is treated as visible so direct render() calls mount.
function gvPanelHidden(container) {
  return !!(container && container.classList &&
    container.classList.contains('code-paths-view') &&
    !container.classList.contains('active'));
}

function gvNodeShape(kind) {
  switch (kind) {
    case 'constructor': return 'diamond';
    case 'method': return 'round-rectangle';
    case 'getter': case 'setter': return 'round-rectangle';
    case 'arrow': return 'round-tag';
    case 'module-init': return 'hexagon';
    default: return 'ellipse';
  }
}

function gvNodeBorderStyle(visibility) {
  if (visibility === 'private') return 'dashed';
  if (visibility === 'module-local') return 'dotted';
  return 'solid';
}

function gvEdgeStyle(resolution) {
  if (resolution === 'static' || resolution === 'constructor') return 'solid';
  if (resolution === 'dynamic-string') return 'dotted';
  return 'dashed';
}

function gvEdgeOpacity(confidence) {
  if (confidence === 'low') return 0.3;
  if (confidence === 'medium') return 0.6;
  return 0.9;
}

// Map a sccId to a stable hue so cyclic clusters are visually grouped.
function gvSccColor(sccId) {
  if (!sccId) return null;
  var h = 0;
  for (var i = 0; i < sccId.length; i++) { h = (h * 31 + sccId.charCodeAt(i)) % 360; }
  return 'hsl(' + h + ', 70%, 55%)';
}

// A view-model node carries the same facets passesFilter() reads off a
// catalog occurrence (filePath, kind, inTestFile). Reuse the shared
// predicate so the Graph view culls exactly like the table views do — a
// filter chip toggled in one view hides the same functions here.
function gvNodePasses(node, filterState) {
  if (typeof passesFilter !== 'function' || !filterState) return true;
  return passesFilter(node, filterState);
}

function gvBuildElements(vm, filterState) {
  var elements = [];
  var visible = {};
  for (var i = 0; i < vm.nodes.length; i++) {
    var n = vm.nodes[i];
    if (!gvNodePasses(n, filterState)) continue;
    visible[n.id] = true;
    var degree = (n.callDegreeIn || 0) + (n.callDegreeOut || 0);
    elements.push({
      group: 'nodes',
      data: {
        id: n.id,
        label: n.label,
        filePath: n.filePath,
        kind: n.kind,
        visibility: n.visibility,
        inTestFile: !!n.inTestFile,
        degree: degree,
        sccId: n.sccId || null,
        sccColor: gvSccColor(n.sccId),
        shape: gvNodeShape(n.kind),
        borderStyle: gvNodeBorderStyle(n.visibility),
      },
    });
  }
  for (var j = 0; j < vm.edges.length; j++) {
    var e = vm.edges[j];
    // An edge survives only when BOTH endpoints survive the filter.
    if (!visible[e.source] || !visible[e.target]) continue;
    elements.push({
      group: 'edges',
      data: {
        id: 'e' + j,
        source: e.source,
        target: e.target,
        lineStyle: gvEdgeStyle(e.resolution),
        edgeOpacity: gvEdgeOpacity(e.confidence),
        isCycleEdge: !!e.isCycleEdge,
      },
    });
  }
  return elements;
}

${dashboardViewGraphStylesheetJs()}

function gvLayoutOptions(layoutId) {
  if (layoutId === 'dagre') {
    return { name: 'dagre', rankDir: 'LR', nodeSep: 14, rankSep: 48, fit: true, padding: 24 };
  }
  if (layoutId === 'breadthfirst') {
    return { name: 'breadthfirst', directed: true, spacingFactor: 1.1, fit: true, padding: 24 };
  }
  return { name: 'cose', animate: false, fit: true, padding: 24, nodeRepulsion: 4500 };
}

function gvRunLayout(layoutId) {
  if (!gvCy) return;
  gvCurrentLayout = layoutId;
  var layout = gvCy.layout(gvLayoutOptions(layoutId));
  layout.run();
}

function gvRenderLayoutSelector(host) {
  var bar = el('div', { class: 'code-paths-graph-toolbar' });
  bar.appendChild(el('span', { class: 'code-paths-graph-toolbar-label', text: 'Layout' }));
  for (var i = 0; i < GV_LAYOUTS.length; i++) {
    (function(layout) {
      var btn = el('button', {
        class: 'code-paths-graph-layout-btn' + (layout.id === gvCurrentLayout ? ' active' : ''),
        'data-layout': layout.id,
        text: layout.label,
        onclick: function() {
          gvRunLayout(layout.id);
          var btns = host.querySelectorAll('.code-paths-graph-layout-btn');
          for (var k = 0; k < btns.length; k++) {
            btns[k].classList.toggle('active', btns[k].dataset.layout === layout.id);
          }
        },
      });
      bar.appendChild(btn);
    })(GV_LAYOUTS[i]);
  }
  // SCC-highlight toggle (folds the former standalone "Cycles / SCCs" view
  // into the topology view — cycles are best *seen* on the node-link graph).
  // When on, cycle members + cycle edges are emphasized and the acyclic
  // remainder is dimmed, so mutually-recursive clusters pop out.
  var sccBtn = el('button', {
    class: 'code-paths-graph-layout-btn code-paths-graph-scc-btn' + (gvSccHighlight ? ' active' : ''),
    'data-scc-toggle': '1',
    text: 'Highlight cycles',
    onclick: function() {
      gvSccHighlight = !gvSccHighlight;
      sccBtn.classList.toggle('active', gvSccHighlight);
      gvApplySccHighlight();
    },
  });
  bar.appendChild(sccBtn);
  host.appendChild(bar);
}

// Emphasize strongly-connected (cyclic) clusters on the live graph. A node
// is "in a cycle" when it carries an sccId; an edge when isCycleEdge is set.
// Toggling off clears the emphasis. Reads the same SCC facets the projector
// already attached to the view-model (graph-view-model.ts) — no second
// Tarjan pass in the browser.
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

// Breadth-first reach set over one of the graphIndexes adjacency maps
// (callers for upstream, callees for downstream). Cycle-safe via a visited
// set. The seed itself is NOT included in the returned set, and self-edges
// are skipped (a node is not treated as its own caller/callee) — both
// choices keep the seed styled 'selected' rather than upstream/downstream.
function gvBfsReach(seedId, adjacency) {
  var reached = {};
  if (!adjacency || typeof adjacency.get !== 'function') return reached;
  var queue = [seedId];
  var visited = {};
  visited[seedId] = true;
  while (queue.length > 0) {
    var cur = queue.shift();
    var neighbors = adjacency.get(cur) || [];
    for (var i = 0; i < neighbors.length; i++) {
      var nxt = neighbors[i];
      if (nxt === seedId) continue; // skip self-edge back to the seed
      if (visited[nxt]) continue;
      visited[nxt] = true;
      reached[nxt] = true;
      queue.push(nxt);
    }
  }
  return reached;
}

function gvClearImpact() {
  if (!gvCy) return;
  gvCy.elements().removeClass('gv-selected gv-upstream gv-downstream gv-dimmed');
}

function gvApplyImpact(seedId, indexes) {
  if (!gvCy || !indexes) return;
  var upstream = gvBfsReach(seedId, indexes.callers);   // who reaches the seed
  var downstream = gvBfsReach(seedId, indexes.callees); // what the seed reaches
  gvCy.batch(function() {
    gvCy.elements().removeClass('gv-selected gv-upstream gv-downstream');
    gvCy.elements().addClass('gv-dimmed');
    gvCy.nodes().forEach(function(n) {
      var id = n.id();
      if (id === seedId) { n.removeClass('gv-dimmed').addClass('gv-selected'); }
      else if (upstream[id]) { n.removeClass('gv-dimmed').addClass('gv-upstream'); }
      else if (downstream[id]) { n.removeClass('gv-dimmed').addClass('gv-downstream'); }
    });
    // Un-dim edges whose endpoints are both in the lit set so the highlighted
    // subgraph reads as connected paths, not just isolated nodes.
    gvCy.edges().forEach(function(ed) {
      var s = ed.source().id();
      var t = ed.target().id();
      var lit = function(id) { return id === seedId || upstream[id] || downstream[id]; };
      if (lit(s) && lit(t)) ed.removeClass('gv-dimmed');
    });
  });
}

// Search box (DOM, above the canvas). Reuses the same fuzzy index the
// Search view uses (fuzzyMatch over simple names). A hit centers + fits the
// matched node and flags it; non-matches fade. Clearing restores opacity.
function gvRenderSearchBox(host) {
  var input = el('input', {
    type: 'search',
    class: 'search-input code-paths-graph-search',
    id: 'code-paths-graph-search-input',
    placeholder: 'Find a node by name…',
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
  // The view-model label is the qualified name; match against it directly
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

views.push({
  id: 'graph',
  label: 'Graph',
  help: {
    title: 'Graph',
    sections: [
      { heading: 'What this is', body: 'A node-link visualization of the call graph rendered with Cytoscape.js. Each node is a function; each edge is a static call. Node size reflects total call degree (callers + callees); cyclic clusters share an accent border.' },
      { heading: 'Why you care', body: 'The seven table views project the graph into rankings and lists. This view shows topology directly — hub functions, tightly cyclic clusters, disconnected islands, and the upstream/downstream radius around a node — which is work to reconstruct from a table.' },
      { heading: 'How to read it', body: 'Node shape encodes kind (diamond=constructor, hexagon=module-init, rounded=method). Border style encodes visibility (solid=exported, dotted=module-local, dashed=private). Edge style encodes call resolution; faded edges are low-confidence. Use the layout selector to switch between layered (dagre), force (cose), and hierarchical (breadthfirst).' },
      { heading: 'What to do', body: 'Pan and zoom to explore. The filter chips above the view tab bar cull nodes here exactly as they cull rows in the table views. Type in the search box to center and highlight a node; non-matches fade. Click a node to trace its upstream/downstream impact.' },
      { heading: 'Cycles / SCCs', body: 'Strongly-connected components are groups of functions that can all reach each other through call edges (found via Tarjan’s algorithm). Click "Highlight cycles" in the toolbar to emphasize cycle members and cycle edges while dimming the acyclic remainder. Size-2 cycles (direct mutual recursion) are usually fine; larger cycles — especially spanning multiple packages — are a layering smell. Break a cycle by extracting the shared protocol into a third place both sides depend on, or by inverting one call into a callback/event.' },
    ],
  },
  render(container, catalog, indexes, filterState) {
    while (container.firstChild) container.removeChild(container.firstChild);
    var vm = gvLoadViewModel();
    if (!vm || !vm.nodes || vm.nodes.length === 0) {
      container.appendChild(el('div', { class: 'empty', text: 'No graph to display.' }));
      return;
    }
    if (typeof cytoscape !== 'function') {
      container.appendChild(el('div', { class: 'empty', text: 'Graph renderer unavailable.' }));
      return;
    }

    // Defer the expensive mount while this panel is hidden (see gvPanelHidden).
    // activateView() re-renders the panel once it becomes visible.
    if (gvPanelHidden(container)) return;

    gvRenderLayoutSelector(container);
    gvRenderSearchBox(container);

    if (typeof vm.truncatedFromTotal === 'number' && vm.truncatedFromTotal > vm.nodes.length) {
      container.appendChild(el('div', {
        class: 'code-paths-graph-banner',
        text: 'Showing top ' + vm.nodes.length + ' of ' + vm.truncatedFromTotal + ' by call degree. Use filters to broaden.',
      }));
    }

    var canvas = el('div', { class: 'code-paths-graph-canvas', id: 'code-paths-graph-canvas' });
    container.appendChild(canvas);

    // Re-render fires on every filterState change (notifyViews fans out to
    // every view's render). Cull nodes/edges the active filter rejects — an
    // edge survives only when both endpoints do.
    var elements = gvBuildElements(vm, filterState);
    if (elements.length === 0) {
      canvas.appendChild(el('div', { class: 'empty', text: 'No nodes match the active filters.' }));
      return;
    }

    // Mounting can throw in environments without a real 2D canvas (e.g.
    // headless test runners). Fail soft — the rest of the page stays usable.
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

    // Click a node → highlight upstream (callers, transitive) and downstream
    // (callees, transitive) reach sets via the shared graphIndexes adjacency
    // lists. Background click or Esc clears.
    gvCy.on('tap', 'node', function(evt) {
      gvApplyImpact(evt.target.id(), indexes);
    });
    gvCy.on('tap', function(evt) {
      if (evt.target === gvCy) gvClearImpact();
    });
    gvCy.__gvEscHandler = function(e) { if (e.key === 'Escape') gvClearImpact(); };
    document.addEventListener('keydown', gvCy.__gvEscHandler);

    // Re-apply the cycle emphasis if the toggle was left on across a re-render.
    gvApplySccHighlight();
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
