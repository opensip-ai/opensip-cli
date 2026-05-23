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
 */

import { fitnessTool } from '@opensip-tools/fitness';
import { graphTool } from '@opensip-tools/graph';

import type { LiveViewRenderer } from '@opensip-tools/core';

/**
 * First-party live-view renderers, keyed by `Tool.metadata.id`. The
 * CLI hands this map to every tool through `ToolCliContext.builtinLiveViews`.
 */
export const builtinLiveViews: ReadonlyMap<string, LiveViewRenderer> = new Map<string, LiveViewRenderer>([
  [
    fitnessTool.metadata.id,
    async (args) => {
      const { renderFitView } = await import('../ui/render.js');
      await renderFitView(args as Parameters<typeof renderFitView>[0]);
    },
  ],
  [
    graphTool.metadata.id,
    async (args) => {
      const { renderGraphView } = await import('../ui/render.js');
      await renderGraphView(args as Parameters<typeof renderGraphView>[0]);
    },
  ],
]);
