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
 * `KIND_LIST`, `gvRenderGraph`, and the `gv*` control-state vars.
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

// The view's own control toolbar (Level / Scope / Package / Kind / Edges).
// This is deliberately self-contained — the shared Explore filter chips govern
// the Functions table, not this view. The Level dropdown decides what the graph
// shows; Package + Kind only apply at function level, so they are DISABLED at
// package level (faded, not hidden) to make that scoping legible. Every change
// re-renders the graph in place via gvRenderGraph(host, catalog, indexes).
function gvRenderControls(host, catalog, indexes) {
  var bar = el('div', { class: 'code-paths-graph-toolbar code-paths-graph-controls' });
  function label(t) { bar.appendChild(el('span', { class: 'code-paths-graph-toolbar-label', text: t })); }
  function rerender() { gvRenderGraph(host, catalog, indexes); }
  var fnLevel = (gvLevel === 'function');

  // Level — always enabled. Drives package vs function granularity.
  label('Level');
  var levelSel = el('select', { class: 'code-paths-graph-select', 'data-control': 'level' });
  gvAddOptions(levelSel, [['package', 'Package'], ['function', 'Function']], gvLevel);
  levelSel.addEventListener('change', function(e) { gvLevel = e.target.value; rerender(); });
  bar.appendChild(levelSel);

  // Scope — always enabled. Production-only vs include-tests.
  label('Scope');
  var scopeSel = el('select', { class: 'code-paths-graph-select', 'data-control': 'scope' });
  gvAddOptions(scopeSel, [['prod', 'Production only'], ['tests', 'Include tests']], gvIncludeTests ? 'tests' : 'prod');
  scopeSel.addEventListener('change', function(e) { gvIncludeTests = (e.target.value === 'tests'); rerender(); });
  bar.appendChild(scopeSel);

  // Package — single-select; function level only (disabled at package level).
  label('Package');
  var pkgs = (typeof packagesInCatalog === 'function') ? packagesInCatalog(catalog) : [];
  var pkgSel = el('select', { class: 'code-paths-graph-select', 'data-control': 'package' });
  pkgSel.appendChild(el('option', { value: '', text: pkgs.length ? '— select —' : '— none —' }));
  gvAddOptions(pkgSel, pkgs.map(function(p) { return [p, p]; }), gvSelectedPackage);
  pkgSel.disabled = !fnLevel;
  pkgSel.addEventListener('change', function(e) { gvSelectedPackage = e.target.value || null; rerender(); });
  bar.appendChild(pkgSel);

  // Kind — multi-select; function level only (disabled at package level).
  label('Kind');
  var kindSel = el('select', { class: 'code-paths-graph-select code-paths-graph-multi', 'data-control': 'kind', multiple: 'multiple' });
  var kinds = (typeof KIND_LIST !== 'undefined') ? KIND_LIST : [];
  for (var k = 0; k < kinds.length; k++) {
    var kopt = el('option', { value: kinds[k], text: kinds[k] });
    if (gvKinds.indexOf(kinds[k]) >= 0) kopt.selected = true;
    kindSel.appendChild(kopt);
  }
  kindSel.disabled = !fnLevel;
  kindSel.addEventListener('change', function(e) {
    var sel = e.target.selectedOptions || [];
    gvKinds = Array.prototype.slice.call(sel).map(function(o) { return o.value; });
    rerender();
  });
  bar.appendChild(kindSel);

  // Edges — function level only: intra-package (default) vs + cross-package.
  if (fnLevel) {
    label('Edges');
    var edgeSel = el('select', { class: 'code-paths-graph-select', 'data-control': 'granularity' });
    gvAddOptions(edgeSel, [['intra', 'Intra-package'], ['cross', '+ cross-package']], gvCrossPackage ? 'cross' : 'intra');
    edgeSel.addEventListener('change', function(e) { gvCrossPackage = (e.target.value === 'cross'); rerender(); });
    bar.appendChild(edgeSel);
  }

  host.appendChild(bar);
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
