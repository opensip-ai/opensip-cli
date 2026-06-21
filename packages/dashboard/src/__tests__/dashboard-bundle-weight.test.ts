/**
 * Bundle-weight CI gate.
 *
 * The Graph view ships a vendored Cytoscape renderer (~482 KB) plus a
 * per-report view-model JSON blob. These assertions fail CI if either
 * grows past the Phase 0 budget, so a careless dependency bump or schema
 * bloat is caught before it lands in every generated report.
 *
 * The Visualization view's JS now lives in the typed client bundle (L4,
 * `DASHBOARD_CLIENT_BUNDLE`) rather than a standalone `dashboardViewGraphJs()`
 * emitter, so the "our own JS" budget is measured against the WHOLE client
 * bundle (every migrated module) rather than the single view's string.
 *
 * Budgets (Phase 0 §1 / §4.5):
 *   - vendor bundle raw:           <= 600 KB
 *   - vendor + our client bundle:  <= 700 KB (BUDGET_KB + 100, accounts for the
 *                                    whole migrated client bundle)
 *   - client bundle alone:         < 200 KB (guards against a data blob sneaking
 *                                    into our hand-written JS)
 *   - view-model JSON per element: within the §4.5 per-node/edge estimates
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DASHBOARD_CLIENT_BUNDLE } from '../client-bundle.generated.js';
import { dashboardCytoscapeVendorJs } from '../code-paths/cytoscape-vendor.js';
import { projectCatalogToGraphViewModel } from '../code-paths/graph-view-model.js';

import type { GraphCatalog } from '@opensip-cli/contracts';

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

  it('vendor + our client bundle together stay within budget + 100 KB', () => {
    const bytes = size(dashboardCytoscapeVendorJs()) + size(DASHBOARD_CLIENT_BUNDLE);
    const kb = Math.round(bytes / KB);
    const limit = (BUDGET_KB + 100) * KB;
    expect(
      bytes,
      `vendor + client bundle ${kb} KB exceeds ${BUDGET_KB + 100} KB budget`,
    ).toBeLessThanOrEqual(limit);
  });

  it('our client bundle is a small fraction of the vendor weight', () => {
    // Guard against our hand-written client JS ballooning (e.g. an accidental
    // inlined data blob). The whole migrated bundle is tens of KB, not hundreds.
    const bundleKb = size(DASHBOARD_CLIENT_BUNDLE) / KB;
    expect(bundleKb).toBeLessThan(200);
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
