/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * Unit tests for `gvRunLayout` (`src/client/view-graph-layout.ts`), imported
 * DIRECTLY (not via the eval'd client bundle used by dashboard-view-graph.test.ts).
 *
 * The bundle-level DOM tests can't exercise `gvRunLayout`'s success path: this
 * repo's jsdom setup has no real 2D canvas context, so `cytoscape(...)` always
 * throws on construction and `gvState.cy` stays null — `gvRunLayout` bails out
 * on its first guard before reaching any layout logic. Testing directly against
 * a fake `CyCore` (only `.layout().run()` is used on this path) sidesteps that
 * environment limitation and exercises the real success/failure branches.
 */
import { beforeEach, describe, expect, it } from 'vitest';

// Side-effect only: brings the `declare global { const cytoscape/cytoscapeDagre }`
// ambient augmentation into this test-typecheck program — `view-graph-layout.ts`
// reads those as bare identifiers, and without this import they're only ambient
// under the separate `src/client/tsconfig.json` compile unit, not here.
import '../client/globals.js';
import { gvRunLayout } from '../client/view-graph-layout.js';
import { gvState } from '../client/view-graph-state.js';

import type { CyCore, CyLayout } from '../client/cytoscape-types.js';

function fakeCy(shouldThrow: (layoutId: string) => boolean): CyCore {
  return {
    layout: (options: Record<string, unknown>) => {
      const layoutId = options.name as string;
      if (shouldThrow(layoutId)) throw new Error(`layout '${layoutId}' failed`);
      return { run: () => undefined } as CyLayout;
    },
  } as unknown as CyCore;
}

beforeEach(() => {
  gvState.cy = null;
  gvState.currentLayout = 'dagre';
  gvState.dagreRegistered = false;
  // `cytoscape`/`cytoscapeDagre` are undeclared globals here (no vendor blob
  // loaded), so `gvRegisterGraphLayouts()` always reports dagre unavailable —
  // exactly the degraded state these tests need, with no vendor setup required.
});

describe('gvRunLayout', () => {
  it('clears a prior dagre-unavailable notice once a later layout switch succeeds', () => {
    // Regression: gvRunLayout re-runs a layout in place (no container remount),
    // so a notice left behind by a failed dagre attempt used to persist forever
    // — even after the user switched to a layout that runs cleanly.
    const cy = fakeCy(() => false); // every layout run succeeds
    gvState.cy = cy;
    const container = document.createElement('div');

    gvRunLayout(container, 'dagre');
    expect(container.querySelector('[data-graph-layout-degradation]')).not.toBeNull();
    expect(container.textContent).toContain('layered layout is unavailable');

    gvRunLayout(container, 'breadthfirst');
    expect(container.querySelector('[data-graph-layout-degradation]')).toBeNull();
    expect(container.textContent).not.toContain('layered layout is unavailable');
  });

  it('leaves the notice in place across a re-run of the same degraded layout', () => {
    const cy = fakeCy(() => false);
    gvState.cy = cy;
    const container = document.createElement('div');

    gvRunLayout(container, 'dagre');
    gvRunLayout(container, 'dagre');
    expect(container.querySelector('[data-graph-layout-degradation]')).not.toBeNull();
  });
});
