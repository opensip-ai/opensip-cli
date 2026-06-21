/**
 * Shared mutable state for the Code Graph "Visualization" view.
 *
 * `view-graph.ts` and `graph-controls.ts` used to run in one concatenated
 * `<script>` scope, sharing a set of `var gv*` control-state vars. As typed
 * bundle modules they live in separate files, so that shared state moves here:
 * a single object the view and its controls both import and mutate.
 *
 * These survive the in-place re-render each control change triggers
 * (`gvRenderGraph`), so they MUST be module-singleton state, not per-render
 * locals. The layout list is a const (the available Cytoscape layouts).
 *
 * Migrated out of the legacy String.raw emitters (L4): real, type-checked
 * TypeScript (DOM lib) bundled into the inlined client `<script>`.
 */

import type { CyCore } from './cytoscape-types.js';

/** Available layouts. dagre is the default for mostly-DAG package graphs; cose
 * (built-in force-directed) reads better when cycles dominate; breadthfirst is
 * a cheap hierarchical fallback. No fcose — it needs a fourth vendored
 * extension and the bundle budget is tight. */
export const GV_LAYOUTS: readonly { id: string; label: string }[] = [
  { id: 'dagre', label: 'Dagre (layered)' },
  { id: 'cose', label: 'Cose (force)' },
  { id: 'breadthfirst', label: 'Breadthfirst' },
];

/**
 * The Visualization view's self-contained control state (NOT the shared Explore
 * filter bar). Mutated by the control handlers in `graph-controls.ts` and read
 * by the render driver in `view-graph.ts`.
 *
 *   level          'package' (default) → package→package rollup blob;
 *                  'function'          → the selected package's functions.
 *   includeTests   Scope dropdown: false = production only (default).
 *   selectedPackage single package chosen at function level (null = none).
 *   kinds          multi-selected function kinds ([] = all).
 *   crossPackage   function-level "Edges" toggle: false = intra-package
 *                  (default), true = also draw edges leaving the package to
 *                  faded external function nodes.
 *   currentLayout  the active Cytoscape layout id.
 *   cy             the live Cytoscape core instance (null until mounted).
 *   sccHighlight   "Highlight cycles" toggle (package-level SCC emphasis).
 *   escHandler     the active Escape keydown handler, tracked so each re-render
 *                  replaces (not stacks) its document-level listener.
 */
export const gvState: {
  level: 'package' | 'function';
  includeTests: boolean;
  selectedPackage: string | null;
  kinds: string[];
  crossPackage: boolean;
  currentLayout: string;
  cy: CyCore | null;
  sccHighlight: boolean;
  escHandler: ((e: KeyboardEvent) => void) | null;
} = {
  level: 'package',
  includeTests: false,
  selectedPackage: null,
  kinds: [],
  crossPackage: false,
  currentLayout: 'dagre',
  cy: null,
  sccHighlight: false,
  escHandler: null,
};
