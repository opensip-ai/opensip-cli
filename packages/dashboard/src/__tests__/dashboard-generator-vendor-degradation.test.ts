import { describe, expect, it, vi } from 'vitest';

vi.mock('../code-paths.js', () => ({
  dashboardCodePathsVendorJs(): string {
    throw new Error('vendor asset missing');
  },
}));

const { generateDashboardHtml } = await import('../generator.js');

describe('generateDashboardHtml — optional graph renderer', () => {
  it('keeps the report usable and records remediation when the vendor asset is absent', () => {
    const html = generateDashboardHtml({ sessions: [] });

    expect(html).toContain('id="graph-visualization-degradations"');
    expect(html).toContain('renderer-asset-unavailable');
    expect(html).toContain('Reinstall opensip-cli or run `pnpm --filter=@opensip-cli/dashboard');
    expect(html).toContain("renderDashboardPanel('panel-overview'");
  });
});
