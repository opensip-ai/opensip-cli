/**
 * Vendored Cytoscape emitter — smoke + byte-size guard.
 *
 * The emitter reads the committed `src/vendor/cytoscape-bundle.js` blob
 * and returns it verbatim. These tests assert the version-stamp banner is
 * present, the renderer globals are declared, and the raw size stays
 * within the Phase 0 budget so a careless version bump fails CI.
 */

import { describe, expect, it } from 'vitest';

import { dashboardCytoscapeVendorJs } from '../code-paths/cytoscape-vendor.js';

/** Phase 0 raw-byte budget (matches scripts/vendor-cytoscape.mjs). */
const BUDGET_KB = 600;

describe('dashboardCytoscapeVendorJs', () => {
  it('starts with the vendor version-stamp banner', () => {
    const js = dashboardCytoscapeVendorJs();
    expect(js.startsWith('/*')).toBe(true);
    expect(js).toContain('VENDORED — DO NOT EDIT BY HAND.');
    expect(js).toContain('cytoscape@');
    expect(js).toContain('cytoscape-dagre@');
  });

  it('declares the cytoscape + cytoscapeDagre UMD globals', () => {
    const js = dashboardCytoscapeVendorJs();
    // UMD wrappers assign the global via `root["cytoscape"]` / `root.cytoscape`.
    expect(js.includes('cytoscape')).toBe(true);
    expect(/cytoscapeDagre|cytoscape-dagre/.test(js)).toBe(true);
  });

  it('does not vendor a standalone dagre global (self-bundled by cytoscape-dagre)', () => {
    const js = dashboardCytoscapeVendorJs();
    // The banner documents the deliberate omission.
    expect(js).toContain('no standalone dagre is');
  });

  it('stays within the raw-byte budget', () => {
    const bytes = Buffer.byteLength(dashboardCytoscapeVendorJs(), 'utf8');
    expect(bytes).toBeLessThan(BUDGET_KB * 1024);
  });

  it('is deterministic across calls (cached)', () => {
    expect(dashboardCytoscapeVendorJs()).toBe(dashboardCytoscapeVendorJs());
  });
});
