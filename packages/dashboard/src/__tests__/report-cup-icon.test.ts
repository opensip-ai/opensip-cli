import { describe, expect, it } from 'vitest';

import { generateDashboardHtml } from '../generator.js';
import { REPORT_CUP_FAVICON_DATA_URI, REPORT_CUP_HEADER_HTML } from '../report-cup-icon.js';

describe('report cup icon', () => {
  it('uses the geometric cup in the favicon data URI', () => {
    expect(REPORT_CUP_FAVICON_DATA_URI).toContain('data:image/svg+xml,');
    const svg = decodeURIComponent(REPORT_CUP_FAVICON_DATA_URI.replace('data:image/svg+xml,', ''));
    expect(svg).toContain('fill="#C8956C"');
    expect(svg).toContain('viewBox="0 0 32 32"');
  });

  it('renders the header mark as the BANNER_MINI_CUP ASCII art (not an SVG)', () => {
    // The header logo mirrors the opensip.ai CoffeeLogo: monospace <pre> of the
    // mini-cup art, steam ⋮ ⋮ + lid near-white, body + saucer brand amber.
    expect(REPORT_CUP_HEADER_HTML).toContain('<pre');
    expect(REPORT_CUP_HEADER_HTML).toContain('⋮ ⋮');
    expect(REPORT_CUP_HEADER_HTML).toContain('▟███▙');
    expect(REPORT_CUP_HEADER_HTML).toContain('#f5f5f5'); // steam + lid
    expect(REPORT_CUP_HEADER_HTML).toContain('#C8956C'); // body + saucer
    expect(REPORT_CUP_HEADER_HTML).not.toContain('<svg');
  });

  it('embeds the cup favicon and header mark in generated HTML', () => {
    const html = generateDashboardHtml({ sessions: [] });
    expect(html).toContain(REPORT_CUP_FAVICON_DATA_URI);
    expect(html).toContain(REPORT_CUP_HEADER_HTML);
    expect(html).not.toContain('M4 8h12');
  });
});
