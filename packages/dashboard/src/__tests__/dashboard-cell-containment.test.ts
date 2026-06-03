/**
 * Containment contract for `.data-table` cells.
 *
 * Long free-text columns (finding messages, file paths, and the code
 * snippets inside suggestions) used to overrun the card edge and bleed
 * past the page boundary, because the table default was
 * `white-space: nowrap` with no break behaviour. The fix flips the
 * BODY-cell default to wrap-and-break, with an explicit `.cell-nowrap`
 * opt-out for short metric columns.
 *
 * This guards the systemic invariant: no view can bleed horizontally
 * unless it deliberately opts a long-text cell out of wrapping.
 */
import { describe, it, expect } from 'vitest';

import { dashboardCss } from '../css.js';
import { generateDashboardHtml } from '../generator.js';

// Collapse whitespace so the assertions don't depend on formatting.
const css = dashboardCss().replace(/\s+/g, ' ');

describe('data-table cell containment contract', () => {
  it('body cells wrap and break long unbreakable tokens by default', () => {
    expect(css).toContain('.data-table td { white-space: normal; overflow-wrap: anywhere; }');
  });

  it('exposes a .cell-nowrap opt-out for short metric columns', () => {
    expect(css).toContain('.data-table td.cell-nowrap { white-space: nowrap; }');
  });

  it('keeps header labels on a single line', () => {
    expect(css).toContain('.data-table th { white-space: nowrap; }');
  });

  it('does not re-introduce a blanket nowrap on body cells', () => {
    // The old footgun: a rule forcing every td onto one line. If this
    // reappears, free-text columns overflow again.
    expect(css).not.toContain('.data-table td, .data-table th { white-space: nowrap; }');
  });

  it('the session timestamp cell opts out via .cell-nowrap', () => {
    // Guards the view wiring: short, space-containing cells (timestamps)
    // must stay on one line under the wrap-by-default contract.
    const html = generateDashboardHtml({ sessions: [] });
    expect(html).toContain("class:'cell-nowrap'");
  });
});
