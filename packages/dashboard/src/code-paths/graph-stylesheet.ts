/**
 * @fileoverview Cytoscape stylesheet for the Code Paths "Graph" view.
 *
 * A render helper (registers no view), extracted from `view-graph.ts` to keep
 * that emitter under the file-length budget and deliberately named out of the
 * `view-*` namespace so it stays clear of the views-disjoint architecture
 * rule. Emits the `gvStylesheet()` browser function as a JS string; the main
 * emitter interpolates it into its `<script>` body. The selectors/colors are
 * the visual encoding (node shape/stroke/size, edge style/opacity, SCC accent,
 * selection/search/impact highlight classes) documented in `view-graph.ts`.
 */

/**
 * Emit the `gvStylesheet()` browser function as a JS string. No leading or
 * trailing newline, so the main emitter can interpolate it where the inline
 * function used to sit and produce byte-identical output.
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
        'border-style': function(ele) { return ele.data('borderStyle'); },
        'shape': function(ele) { return ele.data('shape'); },
        'width': function(ele) { return 18 + Math.min(42, ele.data('degree') * 3); },
        'height': function(ele) { return 18 + Math.min(42, ele.data('degree') * 3); },
        'label': function(ele) {
          var l = ele.data('label') || '';
          return l.length > 28 ? l.slice(0, 27) + '…' : l;
        },
        'font-size': 7,
        'color': '#ddd',
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 2,
        'opacity': function(ele) { return ele.data('inTestFile') ? 0.55 : 1; },
      },
    },
    {
      selector: 'edge',
      style: {
        'width': 1,
        'line-color': '#5a5a5a',
        'line-style': function(ele) { return ele.data('lineStyle'); },
        'opacity': function(ele) { return ele.data('edgeOpacity'); },
        'target-arrow-color': '#5a5a5a',
        'target-arrow-shape': 'triangle',
        'arrow-scale': 0.6,
        'curve-style': 'bezier',
      },
    },
    {
      selector: 'edge[?isCycleEdge]',
      style: { 'line-color': '#d46a6a', 'target-arrow-color': '#d46a6a', 'width': 1.5 },
    },
    {
      selector: 'node.gv-node-selected',
      style: { 'background-color': '#e0a96d', 'border-color': '#fff', 'border-width': 3 },
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
    // Impact highlight (Phase 5). Accent palette mirrors the dashboard
    // theme: --accent (selected), --accent-fitness (downstream),
    // --accent-sim (upstream). Hard-coded here because the Cytoscape canvas
    // can't read CSS custom properties.
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
    // SCC-highlight toggle (folded-in "Cycles / SCCs" affordance). Cycle
    // members get a bright accent fill; cycle edges turn red and thicken;
    // the acyclic remainder fades so mutually-recursive clusters stand out.
    {
      selector: 'node.gv-scc-member',
      style: { 'background-color': '#d46a6a', 'border-color': '#fff', 'border-width': 3, 'opacity': 1 },
    },
    {
      selector: 'edge.gv-scc-edge',
      style: { 'line-color': '#d46a6a', 'target-arrow-color': '#d46a6a', 'width': 2, 'opacity': 1 },
    },
    {
      selector: '.gv-scc-dimmed',
      style: { 'opacity': 0.08 },
    },
  ];
}`;
}
