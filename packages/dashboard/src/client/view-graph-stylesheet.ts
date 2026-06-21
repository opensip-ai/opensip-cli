/**
 * Cytoscape stylesheet for the Code Graph "Visualization" view.
 *
 * A render helper (registers no view), kept in its own module to keep
 * `view-graph.ts` under the file-length budget. Exposes `gvStylesheet()` — the
 * Cytoscape style array the view applies when it mounts the canvas.
 *
 * PACKAGE granularity: nodes are packages, not functions. The visual encoding
 * is therefore simple — uniform round-rectangle nodes sized by total coupling
 * degree, edges thickened by call-count weight, plus the cross-package SCC
 * accent and the shared selection/search/impact highlight classes.
 *
 * Migrated out of the legacy String.raw emitter (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`. The
 * vendored `cytoscape` global supplies the runtime; we only model the slice of
 * its element API the style functions touch (`ele.data(key)`).
 */

/** The slice of a Cytoscape element the style functions read. */
interface CyStyleEle {
  data(key: string): unknown;
}

/** One Cytoscape stylesheet rule: a selector plus a style map. */
interface CyStyleRule {
  selector: string;
  style: Record<string, unknown>;
}

/**
 * The Cytoscape style array for the package-level Visualization view. No
 * leading/trailing churn vs the legacy emitter — the same rules, same order,
 * now type-checked.
 */
export function gvStylesheet(): CyStyleRule[] {
  return [
    {
      selector: 'node',
      style: {
        'background-color': '#c4956a',
        'border-color': (ele: CyStyleEle) => (ele.data('sccColor') as string) || '#8a8a8a',
        'border-width': (ele: CyStyleEle) => (ele.data('sccId') ? 3 : 1),
        shape: 'round-rectangle',
        // Size by total coupling degree (fan-in + fan-out call count). The
        // log-ish clamp keeps a megabus package from dwarfing the canvas.
        width: (ele: CyStyleEle) =>
          22 + Math.min(56, Math.sqrt((ele.data('totalCoupling') as number) || 0) * 6),
        height: (ele: CyStyleEle) =>
          22 + Math.min(56, Math.sqrt((ele.data('totalCoupling') as number) || 0) * 6),
        label: (ele: CyStyleEle) => (ele.data('label') as string) || '',
        'font-size': 9,
        color: '#ddd',
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
        width: (ele: CyStyleEle) =>
          1 + Math.min(7, Math.sqrt((ele.data('weight') as number) || 1) * 1.2),
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
      style: {
        'background-color': '#3a3a3a',
        'border-color': '#666',
        color: '#9a9a9a',
        shape: 'ellipse',
        opacity: 0.55,
      },
    },
    {
      selector: 'node.gv-search-hit',
      style: {
        'background-color': '#e0a96d',
        'border-color': '#fff',
        'border-width': 3,
        opacity: 1,
      },
    },
    {
      selector: 'node.gv-search-fade',
      style: { opacity: 0.12 },
    },
    {
      selector: 'edge.gv-search-fade',
      style: { opacity: 0.05 },
    },
    // Impact highlight (adapted to packages): clicking a package lights its
    // direct caller packages (upstream) and callee packages (downstream).
    // Accent palette mirrors the dashboard theme: --accent (selected),
    // --accent-fitness (downstream), --accent-sim (upstream). Hard-coded
    // because the Cytoscape canvas can't read CSS custom properties.
    {
      selector: 'node.gv-selected',
      style: {
        'background-color': '#e0a96d',
        'border-color': '#fff',
        'border-width': 4,
        opacity: 1,
      },
    },
    {
      selector: 'node.gv-upstream',
      style: { 'background-color': '#6a9bd4', opacity: 1 },
    },
    {
      selector: 'node.gv-downstream',
      style: { 'background-color': '#7ec47e', opacity: 1 },
    },
    {
      selector: '.gv-dimmed',
      style: { opacity: 0.1 },
    },
    // Cross-package cycle highlight (folded-in "Cycles / SCCs" affordance).
    // Cycle members get a bright accent fill; cycle edges turn red and
    // thicken; the acyclic remainder fades so multi-package cycles stand out.
    {
      selector: 'node.gv-scc-member',
      style: {
        'background-color': '#d46a6a',
        'border-color': '#fff',
        'border-width': 3,
        opacity: 1,
      },
    },
    {
      selector: 'edge.gv-scc-edge',
      style: {
        'line-color': '#d46a6a',
        'target-arrow-color': '#d46a6a',
        width: 3,
        opacity: 1,
      },
    },
    {
      selector: '.gv-scc-dimmed',
      style: { opacity: 0.08 },
    },
  ];
}
