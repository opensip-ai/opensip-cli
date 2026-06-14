/**
 * Tests for the generic contributed-tabs renderer (host-owned-run-timing
 * Phase 5 §7.2). The dashboard renders per-run tabs that ANY tool contributes
 * through `ToolDashboardContribution` — data-driven, no tool import.
 *
 * Asserts: (1) a `table` tab inlines its rows + columns; (2) a `cards` tab
 * inlines its fields; (3) a `custom-html` tab is ESCAPED (rendered as text in a
 * <pre>, never injected as raw markup — the security contract for shared
 * reports); (4) tab buttons + panels are emitted for contributed tabs.
 */

import { describe, it, expect } from 'vitest';

import { generateDashboardHtml, type ContributedTab } from '../generator.js';

import type { StoredSession } from '@opensip-cli/contracts';

function emptySessions(): StoredSession[] {
  return [];
}

/** The generator's script-context escape for a single code point (e.g. < → backslash-u003c). */
function unicodeEscape(codePoint: number): string {
  return '\\u' + codePoint.toString(16).padStart(4, '0');
}

describe('contributed dashboard tabs', () => {
  it('emits a tab button + panel for each contributed tab', () => {
    const contributedTabs: ContributedTab[] = [
      {
        id: 'contrib-fit-fit-run-summary',
        title: 'Fitness — Latest Run',
        order: 0,
        view: { kind: 'cards', fields: [{ key: 'score', label: 'Score', format: 'number' }] },
        rows: [{ score: 92 }],
      },
    ];
    const html = generateDashboardHtml({ sessions: emptySessions(), contributedTabs });
    expect(html).toContain('data-tab="contrib-fit-fit-run-summary"');
    expect(html).toContain('id="panel-contrib-fit-fit-run-summary"');
    expect(html).toContain('Fitness — Latest Run');
    expect(html).toContain('renderContributedTabs();');
  });

  it('inlines table columns + rows for a table view', () => {
    const contributedTabs: ContributedTab[] = [
      {
        id: 'contrib-graph-graph-run-units',
        title: 'Graph — Units',
        order: 1,
        view: {
          kind: 'table',
          columns: [
            { key: 'slug', label: 'Unit', format: 'text' },
            { key: 'findings', label: 'Findings', format: 'number' },
          ],
        },
        rows: [{ slug: 'large-function', findings: 3 }],
      },
    ];
    const html = generateDashboardHtml({ sessions: emptySessions(), contributedTabs });
    // The inlined JSON carries the column labels + the row data the client
    // renderer (renderContributedTable) reads.
    expect(html).toContain('large-function');
    expect(html).toContain('Findings');
    expect(html).toContain('renderContributedTable');
  });

  it('inlines card fields for a cards view', () => {
    const contributedTabs: ContributedTab[] = [
      {
        id: 'contrib-sim-sim-run-summary',
        title: 'Simulation — Latest Run',
        order: 0,
        view: {
          kind: 'cards',
          fields: [
            { key: 'score', label: 'Score', format: 'number' },
            { key: 'passed', label: 'Passed', format: 'boolean' },
          ],
        },
        rows: [{ score: 100, passed: true }],
      },
    ];
    const html = generateDashboardHtml({ sessions: emptySessions(), contributedTabs });
    expect(html).toContain('renderContributedCards');
    expect(html).toContain('Simulation — Latest Run');
  });

  it('ESCAPES custom-html (no raw markup injection in a shared report)', () => {
    const malicious = '<img src=x onerror=alert(1)><script>steal()</script>';
    const contributedTabs: ContributedTab[] = [
      {
        id: 'contrib-evil-evil-tab',
        title: 'Evil',
        order: 0,
        view: { kind: 'custom-html', html: malicious },
        rows: [],
      },
    ];
    const html = generateDashboardHtml({ sessions: emptySessions(), contributedTabs });
    // The renderer sets the html as textContent inside a <pre> — so the
    // dangerous sequence must NOT appear as a live element. The inlined JSON
    // carries the value script-context-escaped (< → <), never as a raw
    // top-level `<script>` / `<img>` tag injected into the document body.
    expect(html).toContain('renderContributedCustomHtml');
    // The raw payload's angle brackets are script-context-escaped in the inlined
    // JSON blob (< → <), so the literal "<img src=x" / "<script>steal"
    // markup does not appear verbatim anywhere in the document.
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<script>steal()</script>');
    // The value is still present, ESCAPED, in the inlined JSON (so the client
    // renders it as visible text via textContent, never as live markup). The
    // generator escapes `<`/`>` to the JS unicode escapes (backslash-u003c/e).
    // Build the expected escaped fragment programmatically to avoid this test
    // source itself confusing the escape.
    const escapedImg = `${unicodeEscape(0x3c)}img src=x onerror=alert(1)${unicodeEscape(0x3e)}`;
    expect(html).toContain(escapedImg);
  });

  it('renders nothing extra when no contributed tabs are supplied', () => {
    const html = generateDashboardHtml({ sessions: emptySessions() });
    // The generic renderer is always present (it no-ops on an empty list) but no
    // contrib- panels are emitted.
    expect(html).toContain('renderContributedTabs();');
    expect(html).not.toContain('id="panel-contrib-');
  });
});
