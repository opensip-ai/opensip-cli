/**
 * Code Paths panel — the vendored-renderer orchestrator.
 *
 * The Code Paths panel's client JS (the three views — Coupling / Functions /
 * Visualization — their controls + stylesheet, the ranked-view template, and
 * the panel orchestrator) has been migrated to the typed, DOM-checked client
 * bundle (`src/client/*.ts`, L4). generator.ts inlines that bundle, which
 * registers the views and exposes `renderCodePathsTab` as a page global.
 *
 * The ONLY thing still string-emitted here is the vendored Cytoscape UMD blob
 * (a ~493KB third-party bundle that is NOT our client JS and is deliberately
 * left inlined as a vendor blob). It defines the browser `cytoscape` /
 * `cytoscapeDagre` globals the Visualization view consumes at render time;
 * generator.ts emits it BEFORE the bundle so those globals are present.
 *
 * The graph catalog / view-model JSON blobs are emitted by generator.ts as
 * `<script type="application/json">` elements; the render calls (including
 * `renderCodePathsTab()`) are emitted by generator.ts's registry-derived render
 * block.
 */

import { dashboardCytoscapeVendorJs } from './code-paths/cytoscape-vendor.js';

/**
 * Emit the vendored Cytoscape renderer blob for the Code Paths panel. Kept as a
 * function (rather than re-exporting `dashboardCytoscapeVendorJs` directly) so
 * generator.ts and the bundle-weight test keep a stable, panel-scoped entry
 * point as the vendor blob is the only remaining string-emitted Code Paths JS.
 */
export function dashboardCodePathsVendorJs(): string {
  return dashboardCytoscapeVendorJs();
}
