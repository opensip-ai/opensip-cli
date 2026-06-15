/**
 * @fileoverview Cytoscape stylesheet for the Code Graph "Visualization" view.
 *
 * A render helper (registers no view), extracted from `view-graph.ts` to keep
 * that emitter under the file-length budget and deliberately named out of the
 * `view-*` namespace so it stays clear of the views-disjoint architecture
 * rule. Emits the `gvStylesheet()` browser function as a JS string; the main
 * emitter interpolates it into its `<script>` body.
 *
 * PACKAGE granularity (item 10): nodes are packages, not functions. The
 * visual encoding is therefore simpler than the function-level original —
 * uniform round-rectangle nodes sized by total coupling degree, edges
 * thickened by call-count weight, plus the cross-package SCC accent and the
 * shared selection/search/impact highlight classes.
 */

/**
 * Emit the `gvStylesheet()` browser function as a JS string. No leading or
 * trailing newline, so the main emitter can interpolate it where the inline
 * function used to sit.
 */
export function dashboardViewGraphStylesheetJs(): string {
  return String.raw`function gvStylesheet() {
  return [
    {
      selector: 'node',
      style: {
        'background-color': '#c4956a',
        'border-color': function(ele) { return ele.data('sccColor') || '#8a8a8a'; },
        'border-width': function(ele) { return ele.data('sccId') ? 3 : 1; },
        'shape': 'round-rectangle',
        // Size by total coupling degree (fan-in + fan-out call count). The
        // log-ish clamp keeps a megabus package from dwarfing the canvas.
        'width': function(ele) { return 22 + Math.min(56, Math.sqrt(ele.data('totalCoupling') || 0) * 6); },
        'height': function(ele) { return 22 + Math.min(56, Math.sqrt(ele.data('totalCoupling') || 0) * 6); },
        'label': function(ele) { return ele.data('label') || ''; },
        'font-size': 9,
        'color': '#ddd',
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 2,
        'text-wrap': 'none',
      },
    },
    {
      selector: 'edge',
      style: {
        // Thickness by call-count weight (clamped). A solid uniform style —
        // resolution/confidence encoding is function-level and not meaningful
        // once edges are aggregated to packages.
        'width': function(ele) { return 1 + Math.min(7, Math.sqrt(ele.data('weight') || 1) * 1.2); },
        'line-color': '#5a5a5a',
        'target-arrow-color': '#5a5a5a',
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.8,
        'curve-style': 'bezier',
      },
    },
    {
      selector: 'edge[?isCycleEdge]',
      style: { 'line-color': '#d46a6a', 'target-arrow-color': '#d46a6a' },
    },
    // Function-level "+ cross-package" mode only: a callee that lives OUTSIDE
    // the selected package is drawn as a faded ellipse so the boundary reads
    // at a glance. Package-level view-models never set 'external', so this
    // selector is inert there.
    {
      selector: 'node[?external]',
      style: { 'background-color': '#3a3a3a', 'border-color': '#666', 'color': '#9a9a9a', 'shape': 'ellipse', 'opacity': 0.55 },
    },
    {
      selector: 'node.gv-search-hit',
      style: { 'background-color': '#e0a96d', 'border-color': '#fff', 'border-width': 3, 'opacity': 1 },
    },
    {
      selector: 'node.gv-search-fade',
      style: { 'opacity': 0.12 },
    },
    {
      selector: 'edge.gv-search-fade',
      style: { 'opacity': 0.05 },
    },
    // Impact highlight (adapted to packages): clicking a package lights its
    // direct caller packages (upstream) and callee packages (downstream).
    // Accent palette mirrors the dashboard theme: --accent (selected),
    // --accent-fitness (downstream), --accent-sim (upstream). Hard-coded
    // because the Cytoscape canvas can't read CSS custom properties.
    {
      selector: 'node.gv-selected',
      style: { 'background-color': '#e0a96d', 'border-color': '#fff', 'border-width': 4, 'opacity': 1 },
    },
    {
      selector: 'node.gv-upstream',
      style: { 'background-color': '#6a9bd4', 'opacity': 1 },
    },
    {
      selector: 'node.gv-downstream',
      style: { 'background-color': '#7ec47e', 'opacity': 1 },
    },
    {
      selector: '.gv-dimmed',
      style: { 'opacity': 0.1 },
    },
    // Cross-package cycle highlight (folded-in "Cycles / SCCs" affordance).
    // Cycle members get a bright accent fill; cycle edges turn red and
    // thicken; the acyclic remainder fades so multi-package cycles stand out.
    {
      selector: 'node.gv-scc-member',
      style: { 'background-color': '#d46a6a', 'border-color': '#fff', 'border-width': 3, 'opacity': 1 },
    },
    {
      selector: 'edge.gv-scc-edge',
      style: { 'line-color': '#d46a6a', 'target-arrow-color': '#d46a6a', 'width': 3, 'opacity': 1 },
    },
    {
      selector: '.gv-scc-dimmed',
      style: { 'opacity': 0.08 },
    },
  ];
}`;
}
