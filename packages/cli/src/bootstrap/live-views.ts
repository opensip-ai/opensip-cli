/**
 * live-views — first-party live-view renderer map, keyed by
 * `Tool.metadata.id`.
 *
 * Transitional shape (audit 2026-05-23 G3). Each first-party tool's
 * `register(cli)` calls `cli.builtinLiveViews.get(tool.metadata.id)` to
 * recover the renderer the CLI ships and re-keys it into the live-view
 * registry under the tool's preferred view key. The two-step handshake
 * exists because:
 *
 *   - The renderers themselves live in the CLI's React/Ink layer
 *     (`ui/render.ts`); shipping them inside each tool would force tool
 *     packages to depend on Ink and the CLI's UI components.
 *   - Tools own their live-view *key* (`fit`, `graph`, …) but not the
 *     *renderer*; the CLI hands the renderer back through this map.
 *
 * Layer 5 Phase 3 collapses the indirection: tool controllers move into
 * their packages, each tool ships its own renderer, and `register(cli)`
 * calls `cli.registerLiveView(key, renderer)` directly. The map and the
 * self-lookup handshake go away as a single-file delete. Until then,
 * adding a fourth first-party tool with a live view requires an entry
 * here — flagged as a Phase-3 prerequisite.
 *
 * The map is derived from `FIRST_PARTY_TOOLS` (rather than re-stating
 * tool ids inline) so a `metadata.id` rename in either tool surfaces as
 * a TypeScript reference error rather than a silent
 * `UnknownLiveViewError` at first interactive use.
 *
 * Datastore threading: `createBuiltinLiveViews(datastore)` builds the
 * map per-bootstrap so `renderFitView` / `renderGraphView` see the
 * bootstrap-opened DataStore handle without each tool having to
 * smuggle it through the (deliberately tool-agnostic) `args: unknown`
 * channel of `LiveViewRenderer`. The legacy `builtinLiveViews` static
 * export builds a map with no datastore — kept so existing tests that
 * import the constant continue to pass; production wires through the
 * factory.
 */

import { fitnessTool } from '@opensip-tools/fitness';
import { graphTool } from '@opensip-tools/graph';

import type { LiveViewRenderer } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

/**
 * Build the first-party live-view renderer map. Each renderer closes
 * over the supplied `datastore` so persistence (FitView session writes,
 * graph dashboard catalog hydration) reaches the SQLite handle opened
 * by the bootstrap.
 */
export function createBuiltinLiveViews(
  datastore?: DataStore,
): ReadonlyMap<string, LiveViewRenderer> {
  return new Map<string, LiveViewRenderer>([
    [
      fitnessTool.metadata.id,
      async (args) => {
        const { renderFitView } = await import('../ui/render.js');
        await renderFitView(args as Parameters<typeof renderFitView>[0], datastore);
      },
    ],
    [
      graphTool.metadata.id,
      async (args) => {
        const { renderGraphView } = await import('../ui/render.js');
        await renderGraphView(args as Parameters<typeof renderGraphView>[0], datastore);
      },
    ],
  ]);
}

/**
 * Legacy static map — no datastore captured. Retained for tests that
 * import the constant; production code goes through
 * `createBuiltinLiveViews(datastore)` from the bootstrap.
 */
export const builtinLiveViews: ReadonlyMap<string, LiveViewRenderer> =
  createBuiltinLiveViews();
