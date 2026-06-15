/**
 * Vendored Cytoscape emitter.
 *
 * Reads the committed `src/vendor/cytoscape-bundle.js` UMD blob at
 * generation time and returns it as a JS string for inlining into the
 * report's single `<script>` block. The bundle registers the `cytoscape`
 * and `cytoscapeDagre` browser globals the Graph view (`view-graph.ts`)
 * consumes — fully offline, no CDN, no network at view time.
 *
 * Architectural note: this module reads the bundle via `node:fs`, it does
 * NOT `import 'cytoscape'`. That is deliberate — the `dashboard-no-ui-
 * framework` dependency-cruiser rule forbids importing a visualization
 * library into `packages/dashboard/src/`. The renderer reaches the report
 * as committed source text, never as a module dependency. The `cytoscape`
 * / `cytoscape-dagre` packages are devDependencies used only by the vendor
 * build script (`scripts/vendor-cytoscape.mjs`), which lives outside
 * `src/` and so is out of the rule's scope.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Candidate locations for the committed bundle. The first is the build
 * copy that lives next to the compiled module (`dist/vendor/` — produced
 * by the `copy-vendor` build step and shipped in the published tarball);
 * the rest resolve back to the source tree for the monorepo / test runs
 * where `dist/vendor/` may not exist.
 */
const BUNDLE_CANDIDATES = [
  join(HERE, '..', 'vendor', 'cytoscape-bundle.js'),
  join(HERE, '..', '..', 'src', 'vendor', 'cytoscape-bundle.js'),
];

let cachedBundle: string | null = null;

/**
 * Read and cache the committed Cytoscape UMD bundle from the first candidate
 * path that exists.
 *
 * @throws {Error} When the bundle is absent from every candidate path (the
 *   `vendor:cytoscape` build step has not been run / the asset was not shipped).
 */
function readVendorBundle(): string {
  if (cachedBundle !== null) return cachedBundle;
  for (const candidate of BUNDLE_CANDIDATES) {
    try {
      cachedBundle = readFileSync(candidate, 'utf8');
      return cachedBundle;
    } catch {
      // @swallow-ok candidate-path probe: a missing candidate is expected
      // (dist vs src layout). The final `throw` below reports if ALL fail.
      continue;
    }
  }
  throw new Error(
    'cytoscape-bundle.js not found. Run `pnpm --filter=@opensip-cli/dashboard vendor:cytoscape`.',
  );
}

/**
 * Emit the vendored Cytoscape UMD bundle as a JS string for inlining.
 *
 * MUST be concatenated into the Code Paths script BEFORE any view emitter
 * that references the `cytoscape` global (i.e. before
 * `dashboardViewGraphJs()`).
 */
export function dashboardCytoscapeVendorJs(): string {
  return readVendorBundle();
}
