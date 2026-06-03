/**
 * @fileoverview Visualization control toolbar + function-level projector.
 *
 * A render helper (registers no view), extracted from `view-graph.ts` to keep
 * that emitter under the file-length budget — and, like `graph-stylesheet.ts`,
 * deliberately named out of the `view-*` namespace so it stays clear of the
 * views-disjoint architecture rule. Emits two browser functions plus a tiny
 * helper as a JS string; the main emitter interpolates it into its `<script>`
 * body, so they share one runtime scope with the view's state vars
 * (`gvLevel`, `gvSelectedPackage`, …) and `gvRenderGraph`.
 *
 *  - `gvRenderControls(host, catalog, indexes)` — the self-contained Level /
 *    Scope / Package / Kind / Edges control bar. Package + Kind are disabled at
 *    package level (they only apply at function level). Every change re-renders
 *    the graph in place via `gvRenderGraph`.
 *  - `gvBuildFunctionElements(indexes, pkg, includeTests, kinds, crossPackage)`
 *    — projects ONE package's function call graph client-side from the catalog
 *    indexes (the package→package view-model blob can't express it).
 *  - `gvAddOptions(sel, pairs, current)` — small `<select>` option builder.
 *
 * Free identifiers (supplied by earlier prelude emitters / the host template):
 * `el`, `pkgOf`, `displayName`, `resolveCalleeOcc`, `packagesInCatalog`,
 * `KIND_LIST`, `gvRenderGraph`, `GV_LAYOUTS`, `gvRunLayout`, `gvSccHighlight`,
 * `gvApplySccHighlight`, and the `gv*` control-state vars.
 */
export function dashboardGraphControlsJs(): string {
  return String.raw`
// Append [value, label] option pairs to a select, marking 'current' selected.
function gvAddOptions(sel, pairs, current) {
  for (var i = 0; i < pairs.length; i++) {
    var opt = el('option', { value: pairs[i][0], text: pairs[i][1] });
    if (pairs[i][0] === current) opt.selected = true;
    sel.appendChild(opt);
  }
}

// The view's dropdown controls, laid out as a single CSS GRID (label/control
// columns shared across both rows so everything lines up like a table). The
// search box (gvRenderSearchBox) and the Highlight-cycles checkbox
// (gvRenderCyclesToggle) render below this grid:
//   Row 1: Layout · Scope
//   Row 2: Level · Package · Kind (· Edges, function level only)
// One grid (not two flex rows) is what makes the columns align: the label
// columns auto-size to the widest label across BOTH rows, and the control
// columns are a fixed width, so LAYOUT/LEVEL, SCOPE/PACKAGE, etc. line up.
// Self-contained (the shared Explore filter bar was removed). The Level
// dropdown decides what the graph shows; Package + Kind only apply at function
// level, so they are DISABLED at package level (faded, not hidden). Most
// changes re-render the graph in place via gvRenderGraph; Layout re-runs the
// layout on the live graph (no remount).
function gvRenderControls(host, catalog, indexes) {
  function rerender() { gvRenderGraph(host, catalog, indexes); }
  var fnLevel = (gvLevel === 'function');
  var grid = el('div', { class: 'code-paths-graph-grid' });
  // label() — a column-1 (row-start) label, hugs the left. labelG() — a
  // group-start label in a later column; carries a small left margin so the
  // group reads as separate while its own dropdown stays tight beside it.
  function label(t) { grid.appendChild(el('span', { class: 'code-paths-graph-toolbar-label', text: t })); }
  function labelG(t) { grid.appendChild(el('span', { class: 'code-paths-graph-toolbar-label code-paths-graph-grid-group', text: t })); }

  // ---- Row 1: Layout · Scope · Highlight cycles ----
  // Layout — dropdown; re-runs the layout on the live graph (no full remount).
  label('Layout');
  var layoutSel = el('select', { class: 'code-paths-graph-select', 'data-control': 'layout' });
  gvAddOptions(layoutSel, GV_LAYOUTS.map(function(l) { return [l.id, l.label]; }), gvCurrentLayout);
  layoutSel.addEventListener('change', function(e) { gvRunLayout(e.target.value); });
  grid.appendChild(layoutSel);

  // Scope — always enabled. Production-only vs include-tests.
  labelG('Scope');
  var scopeSel = el('select', { class: 'code-paths-graph-select', 'data-control': 'scope' });
  gvAddOptions(scopeSel, [['prod', 'Production only'], ['tests', 'Include tests']], gvIncludeTests ? 'tests' : 'prod');
  scopeSel.addEventListener('change', function(e) { gvIncludeTests = (e.target.value === 'tests'); rerender(); });
  grid.appendChild(scopeSel);

  // ---- Row 2: Level · Package · Kind (· Edges) ----
  // The Level label carries 'code-paths-graph-grid-break' (grid-column: 1) so it
  // starts a fresh grid row even though row 1 left cols 5-8 empty (the cycles
  // checkbox that used to fill them now lives below the search box).
  grid.appendChild(el('span', { class: 'code-paths-graph-toolbar-label code-paths-graph-grid-break', text: 'Level' }));
  var levelSel = el('select', { class: 'code-paths-graph-select', 'data-control': 'level' });
  gvAddOptions(levelSel, [['package', 'Package'], ['function', 'Function']], gvLevel);
  levelSel.addEventListener('change', function(e) { gvLevel = e.target.value; rerender(); });
  grid.appendChild(levelSel);

  // Package — single-select; function level only (disabled at package level).
  labelG('Package');
  var pkgs = (typeof packagesInCatalog === 'function') ? packagesInCatalog(catalog) : [];
  var pkgSel = el('select', { class: 'code-paths-graph-select', 'data-control': 'package' });
  pkgSel.appendChild(el('option', { value: '', text: pkgs.length ? '— select —' : '— none —' }));
  gvAddOptions(pkgSel, pkgs.map(function(p) { return [p, p]; }), gvSelectedPackage);
  pkgSel.disabled = !fnLevel;
  pkgSel.addEventListener('change', function(e) { gvSelectedPackage = e.target.value || null; rerender(); });
  grid.appendChild(pkgSel);

  // Kind — multi-select dropdown; function level only (disabled at package
  // level). A custom checkbox popover (gvMultiSelect) rather than a native
  // <select multiple> listbox, which renders as an always-open box.
  labelG('Kind');
  grid.appendChild(gvMultiSelect({
    id: 'kind',
    items: (typeof KIND_LIST !== 'undefined') ? KIND_LIST : [],
    selected: gvKinds,
    allLabel: 'All kinds',
    disabled: !fnLevel,
    onClose: function(sel) { gvKinds = sel; rerender(); },
  }));

  // Edges — function level only: intra-package (default) vs + cross-package.
  if (fnLevel) {
    labelG('Edges');
    var edgeSel = el('select', { class: 'code-paths-graph-select', 'data-control': 'granularity' });
    gvAddOptions(edgeSel, [['intra', 'Intra-package'], ['cross', '+ cross-package']], gvCrossPackage ? 'cross' : 'intra');
    edgeSel.addEventListener('change', function(e) { gvCrossPackage = (e.target.value === 'cross'); rerender(); });
    grid.appendChild(edgeSel);
  }

  host.appendChild(grid);
}

// The "Highlight cycles" checkbox — rendered on its own line BELOW the search
// box (row 3+), not in the control grid. Package-level SCC emphasis; toggles
// the emphasis on the live graph in place (no re-render).
function gvRenderCyclesToggle(host) {
  var sccToggle = el('label', { class: 'code-paths-graph-checkbox code-paths-graph-cycles-row' });
  var sccCb = el('input', { type: 'checkbox', 'data-scc-toggle': '1' });
  sccCb.checked = gvSccHighlight;
  sccCb.addEventListener('change', function() { gvSccHighlight = sccCb.checked; gvApplySccHighlight(); });
  sccToggle.appendChild(sccCb);
  sccToggle.appendChild(document.createTextNode(' Highlight cycles'));
  host.appendChild(sccToggle);
}

// A compact multi-select dropdown: a trigger button + a checkbox popover.
// Native <select multiple> renders an ugly always-open listbox, so we roll a
// small popover instead. Checkboxes toggle the selection live and update the
// trigger label; the graph re-renders only when the panel CLOSES (trigger
// re-click or outside click) so a remount doesn't fire on every checkbox.
//   opts: { id, items:[string], selected:[string], allLabel, disabled, onClose }
function gvMultiSelect(opts) {
  var wrap = el('div', { class: 'code-paths-graph-ms' });
  var selected = opts.selected.slice();
  function triggerLabel() {
    if (selected.length === 0) return opts.allLabel;
    if (selected.length === 1) return selected[0];
    return selected.length + ' selected';
  }
  var trigger = el('button', { class: 'code-paths-graph-select code-paths-graph-ms-trigger', 'data-control': opts.id, text: triggerLabel() + ' ▾' });
  trigger.disabled = !!opts.disabled;
  var panel = el('div', { class: 'code-paths-graph-ms-panel' });
  panel.style.display = 'none';
  var open = false;
  var docHandler = null;
  function close() {
    if (!open) return;
    open = false;
    panel.style.display = 'none';
    if (docHandler) { document.removeEventListener('mousedown', docHandler); docHandler = null; }
    opts.onClose(selected.slice());
  }
  function openPanel() {
    if (open || opts.disabled) return;
    open = true;
    panel.style.display = 'block';
    docHandler = function(e) { if (!wrap.contains(e.target)) close(); };
    document.addEventListener('mousedown', docHandler);
  }
  trigger.addEventListener('click', function() { if (open) close(); else openPanel(); });
  for (var i = 0; i < opts.items.length; i++) {
    (function(item) {
      var row = el('label', { class: 'code-paths-graph-ms-item' });
      var cb = el('input', { type: 'checkbox' });
      cb.checked = selected.indexOf(item) >= 0;
      cb.addEventListener('change', function() {
        var ix = selected.indexOf(item);
        if (cb.checked && ix < 0) selected.push(item);
        else if (!cb.checked && ix >= 0) selected.splice(ix, 1);
        trigger.textContent = triggerLabel() + ' ▾';
      });
      row.appendChild(cb);
      row.appendChild(document.createTextNode(' ' + item));
      panel.appendChild(row);
    })(opts.items[i]);
  }
  wrap.appendChild(trigger);
  wrap.appendChild(panel);
  return wrap;
}

// Project the function-level graph for a single package, client-side from the
// embedded catalog indexes (the package->package view-model blob can't express
// it). Nodes = the package's functions passing the Scope/Kind filters; edges =
// resolved function->function calls. Intra-package mode keeps only calls whose
// callee is in the same package; "+ cross-package" mode also keeps calls
// leaving the package, drawing the external callee as a faded node. Node size
// (totalCoupling) is the incident-edge degree. Bounded by package size.
function gvBuildFunctionElements(indexes, pkg, includeTests, kinds, crossPackage) {
  var elements = [];
  if (!indexes || !indexes.occurrencesByHash || !indexes.callees) return elements;
  var kindSet = (kinds && kinds.length) ? kinds : null;
  function passes(occ) {
    if (!includeTests && occ.inTestFile) return false;
    if (kindSet && kindSet.indexOf(occ.kind) < 0) return false;
    return true;
  }

  // Seeds: one occurrence per bodyHash that lives in 'pkg' and passes filters.
  var seeds = [];
  var seenSeed = {};
  indexes.occurrencesByHash.forEach(function(occs) {
    for (var i = 0; i < occs.length; i++) {
      if (pkgOf(occs[i]) === pkg && passes(occs[i])) {
        if (!seenSeed[occs[i].bodyHash]) { seenSeed[occs[i].bodyHash] = true; seeds.push(occs[i]); }
        break;
      }
    }
  });

  var nodeIds = {};
  var degree = {};
  function addNode(occ, external) {
    if (nodeIds[occ.bodyHash]) return;
    nodeIds[occ.bodyHash] = true;
    if (degree[occ.bodyHash] === undefined) degree[occ.bodyHash] = 0;
    elements.push({ group: 'nodes', data: { id: occ.bodyHash, label: displayName(occ.simpleName), external: external ? 1 : 0, totalCoupling: 0 } });
  }
  for (var s = 0; s < seeds.length; s++) addNode(seeds[s], false);

  var edgeSeen = {};
  for (var s2 = 0; s2 < seeds.length; s2++) {
    var seed = seeds[s2];
    var targets = indexes.callees.get(seed.bodyHash) || [];
    for (var t = 0; t < targets.length; t++) {
      var callee = resolveCalleeOcc(targets[t], seed, indexes);
      if (!callee) continue;
      var external = (pkgOf(callee) !== pkg);
      if (external && !crossPackage) continue;
      if (!external && !passes(callee)) continue;
      addNode(callee, external);
      var ekey = seed.bodyHash + '\n' + callee.bodyHash;
      if (edgeSeen[ekey]) continue;
      edgeSeen[ekey] = true;
      elements.push({ group: 'edges', data: { id: 'fe' + s2 + '_' + t, source: seed.bodyHash, target: callee.bodyHash, weight: 1, isCycleEdge: false } });
      degree[seed.bodyHash] = (degree[seed.bodyHash] || 0) + 1;
      degree[callee.bodyHash] = (degree[callee.bodyHash] || 0) + 1;
    }
  }
  for (var e = 0; e < elements.length; e++) {
    if (elements[e].group === 'nodes') elements[e].data.totalCoupling = degree[elements[e].data.id] || 0;
  }
  return elements;
}
`;
}
