import { describe, expect, it } from 'vitest';

import { generateDashboardHtml } from '../generator.js';

describe('dashboard report selection embedding', () => {
  it('embeds a validated initial selection through the script-safe literal seam', () => {
    const html = generateDashboardHtml({
      sessions: [],
      selection: { view: 'change-impact', runId: 'run_A-1' },
    });

    expect(html).toContain('const REPORT_SELECTION = {"view":"change-impact","runId":"run_A-1"};');
  });

  it('keeps Overview-compatible null when no selection is supplied', () => {
    const html = generateDashboardHtml({ sessions: [] });
    expect(html).toContain('const REPORT_SELECTION = null;');
  });

  it('does not embed hostile run identity text', () => {
    const html = generateDashboardHtml({
      sessions: [],
      selection: {
        view: 'change-impact',
        runId: '</script><script>alert(1)</script>',
      },
    });

    expect(html).toContain('const REPORT_SELECTION = {"view":"change-impact"};');
    expect(html).not.toContain('const REPORT_SELECTION = {"view":"change-impact","runId"');
  });
});
