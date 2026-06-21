/**
 * Help-drawer copy for the Code Graph "Visualization" view.
 *
 * Extracted from `view-graph.ts` so that module stays under the file-length
 * budget — this is static descriptive content, not logic. The help drawer reads
 * it via the registered view's `help` field.
 */

import type { ViewHelp } from './code-paths-types.js';

export const GRAPH_VIEW_HELP: ViewHelp = {
  title: 'Visualization',
  sections: [
    {
      heading: 'What this is',
      body: 'A node-link visualization of the call graph, rendered with Cytoscape.js. At Package level each node is a package and each edge is the directed coupling from one package into another; node size reflects total coupling (calls in + calls out) and edge thickness reflects the number of call edges. At Function level it shows the functions of one selected package and the calls among them.',
    },
    {
      heading: 'Levels',
      body: 'Use the Level control to switch between Package (the whole-repo package rollup, the same data as the Coupling matrix) and Function (one package at a time). Function level enables the Package picker (which package to show) and the Kind multi-select, plus an Edges toggle: "Intra-package" shows only calls inside the package; "+ cross-package" also draws calls leaving the package to faded external nodes. The Scope control (production only vs include tests) applies at both levels.',
    },
    {
      heading: 'Why you care',
      body: 'The table views project the graph into rankings and lists, and the Coupling matrix shows the same package data as a grid. This view shows that topology directly — hub packages, tightly-coupled clusters, and circular package dependencies at package level; the internal call structure of a single package at function level.',
    },
    {
      heading: 'How to read it',
      body: 'Bigger nodes are more coupled; thicker edges carry more calls. Use the layout selector to switch between layered (dagre), force (cose), and hierarchical (breadthfirst). The matrix on the Coupling tab is the package-level data in tabular form.',
    },
    {
      heading: 'What to do',
      body: 'Pan and zoom to explore. Type in the search box to center and highlight a node by name; non-matches fade. Click a node to trace its direct callers (upstream) and callees (downstream).',
    },
    {
      heading: 'Cross-package cycles',
      body: 'Strongly-connected components are groups of packages that can all reach each other through call edges (found via Tarjan’s algorithm). Click "Highlight cycles" in the toolbar to emphasize cycle members and cycle edges while dimming the acyclic remainder. A cycle between packages is usually a layering smell. Break it by extracting the shared protocol into a third package both sides depend on, or by inverting one call into a callback/event.',
    },
  ],
};
