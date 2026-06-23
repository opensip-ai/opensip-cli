/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * YAGNI tab renderer (`renderYagniTab`). The yagni tool ships a tab via the
 * `defineToolTab` registry (tool-tabs-registrations.ts); this exercises the
 * client-side renderer it points at:
 *   1. Two subtabs — Sessions (id 'overview', stable for routing) + Detectors.
 *   2. The detector catalog renders one row per detector, with a "graph" badge
 *      for graph-backed detectors and the summary line above the table.
 *   3. An empty catalog falls back to a graceful empty state.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { DASHBOARD_CLIENT_BUNDLE } from '../client-bundle.generated.js';

interface YagniDetector {
  id: string;
  slug: string;
  description?: string;
  requiresGraph?: boolean;
}

interface YagniSummary {
  detectorCount?: number;
  graphBackedCount?: number;
  contractVersion?: string;
}

interface Env {
  render: (catalog: YagniDetector[], summary: YagniSummary | null) => HTMLElement;
}

function loadEnv(): Env {
  // Define the page-global data the generated <script> const block would supply
  // before the bundle runs (checks.ts reads `sessions` at module load; the YAGNI
  // renderer reads `yagniSessions` / `yagniCatalog` / `yagniSummary`). `var`
  // bindings are mutable so each render can re-seed the catalog + summary.
  const dataPrelude = `var sessions = []; var yagniSessions = []; var yagniCatalog = []; var yagniSummary = null;\n`;
  const tail = `
return {
  render: function(catalog, summary) {
    yagniCatalog = catalog;
    yagniSummary = summary;
    document.body.innerHTML = '<div id="panel-yagni" class="tab-panel"></div>';
    renderYagniTab();
    return document.querySelector('#panel-yagni');
  },
};
`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: our own emitted dashboard JS.
  const factory = new Function(dataPrelude + DASHBOARD_CLIENT_BUNDLE + '\n' + tail);
  return factory() as Env;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('renderYagniTab', () => {
  it('renders exactly two subtabs: Sessions (overview) and Detectors (catalog)', () => {
    const panel = loadEnv().render([], null);
    const subtabs = [...panel.querySelectorAll<HTMLElement>('.subtab')].map((s) => ({
      id: s.dataset.subtab,
      label: s.textContent,
    }));
    expect(subtabs).toEqual([
      { id: 'overview', label: 'Sessions' },
      { id: 'catalog', label: 'Detectors' },
    ]);
  });

  it('renders a data-table card with one row per detector, mirroring the graph catalog', () => {
    const panel = loadEnv().render(
      [
        { id: '1', slug: 'unused-export', description: 'Export with no importers' },
        {
          id: '2',
          slug: 'unreferenced-symbol',
          description: 'Symbol never called',
          requiresGraph: true,
        },
      ],
      { detectorCount: 2, graphBackedCount: 1, contractVersion: '1.0.0' },
    );
    const catalog = panel.querySelector<HTMLElement>('#panel-yagni-catalog')!;
    // Summary line reflects the counts.
    expect(catalog.querySelector('.muted')?.textContent).toContain('2 detectors');
    expect(catalog.querySelector('.muted')?.textContent).toContain('1 graph-backed');
    // Same structural shape as the graph rule catalog: a data-table inside a card.
    expect(catalog.querySelector('.card table.data-table')).not.toBeNull();
    // Column headers match the graph catalog's shape (Severity → Evidence).
    const headers = [...catalog.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(headers).toEqual(['Detector', 'Description', 'Evidence', 'Source']);
    // Detectors are sorted by slug; the first cell of each row is the slug.
    const slugs = [...catalog.querySelectorAll('tbody tr td:first-child')].map(
      (c) => c.textContent,
    );
    expect(slugs).toEqual(['unreferenced-symbol', 'unused-export']);
    // First row is the graph-backed detector → Evidence 'graph'; both rows are 'built-in'.
    const evidence = [...catalog.querySelectorAll('tbody tr td:nth-child(3) .badge')].map(
      (b) => b.textContent,
    );
    expect(evidence).toEqual(['graph', 'static']);
    const sources = [...catalog.querySelectorAll('tbody tr td:nth-child(4) .badge')].map(
      (b) => b.textContent,
    );
    expect(sources).toEqual(['built-in', 'built-in']);
  });

  it('shows a graceful empty state when no detectors are available', () => {
    const panel = loadEnv().render([], null);
    const catalog = panel.querySelector<HTMLElement>('#panel-yagni-catalog')!;
    expect(catalog.querySelector('.empty')?.textContent).toBe('No detectors available yet.');
  });
});
