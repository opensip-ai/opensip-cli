/**
 * Bundle-weight CI gate.
 *
 * The Graph view ships a vendored Cytoscape renderer (~482 KB) plus a
 * per-report view-model JSON blob. These assertions fail CI if either
 * grows past the Phase 0 budget, so a careless dependency bump or schema
 * bloat is caught before it lands in every generated report.
 *
 * Budgets (Phase 0 §1 / §4.5):
 *   - vendor bundle raw:           <= 600 KB
 *   - vendor + view emitter JS:    <= 650 KB (BUDGET_KB + 50, accounts for
 *                                    view-graph.ts's own emitted JS string)
 *   - view-model JSON per element: within the §4.5 per-node/edge estimates
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { dashboardCytoscapeVendorJs } from '../code-paths/cytoscape-vendor.js';
import { projectCatalogToGraphViewModel } from '../code-paths/graph-view-model.js';
import { dashboardViewGraphJs } from '../code-paths/view-graph.js';

import type { GraphCatalog } from '@opensip-tools/contracts';

/** Phase 0 §1 raw-byte budget for the vendor bundle. */
const BUDGET_KB = 600;
const KB = 1024;

const HERE = dirname(fileURLToPath(import.meta.url));

function loadFixture(): GraphCatalog {
  const candidates = [
    join(HERE, 'fixtures', 'catalog-small.json'),
    join(HERE, '..', '..', 'src', '__tests__', 'fixtures', 'catalog-small.json'),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as GraphCatalog;
    } catch {
      // next
    }
  }
  throw new Error('catalog-small.json fixture not found');
}

function size(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

describe('bundle weight gate', () => {
  it('vendor bundle stays within the raw-byte budget', () => {
    const bytes = size(dashboardCytoscapeVendorJs());
    const kb = Math.round(bytes / KB);
    expect(bytes, `vendor bundle ${kb} KB exceeds ${BUDGET_KB} KB budget`).toBeLessThanOrEqual(
      BUDGET_KB * KB,
    );
  });

  it('vendor + Graph view emitter together stay within budget + 50 KB', () => {
    const bytes = size(dashboardCytoscapeVendorJs()) + size(dashboardViewGraphJs());
    const kb = Math.round(bytes / KB);
    const limit = (BUDGET_KB + 50) * KB;
    expect(bytes, `vendor + view JS ${kb} KB exceeds ${(BUDGET_KB + 50)} KB budget`).toBeLessThanOrEqual(
      limit,
    );
  });

  it('the Graph view emitter JS is a small fraction of the bundle', () => {
    // Guard against the view emitter itself ballooning (e.g. an accidental
    // inlined data blob). It is hand-written JS; tens of KB, not hundreds.
    const viewKb = size(dashboardViewGraphJs()) / KB;
    expect(viewKb).toBeLessThan(50);
  });

  it('projected (package-level) view-model JSON stays within the per-node/edge byte budget', () => {
    const vm = projectCatalogToGraphViewModel(loadFixture());
    const bytes = size(JSON.stringify(vm));
    // Package nodes are slim ({id,label,totalCoupling,sccId}) and there are
    // few of them — fixed JSON overhead dominates at this scale, so the
    // per-element estimate carries a generous constant floor.
    const budget = Math.round((vm.nodes.length * 160 + vm.edges.length * 100) * 1.5) + 1024;
    const perNode = vm.nodes.length > 0 ? bytes / vm.nodes.length : 0;
    expect(
      bytes,
      `view-model ${bytes} B (~${Math.round(perNode)} B/node) exceeds ${budget} B budget`,
    ).toBeLessThan(budget);
  });
});
