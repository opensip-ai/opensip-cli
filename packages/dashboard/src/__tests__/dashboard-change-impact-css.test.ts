import { describe, expect, it } from 'vitest';

import { dashboardCssChangeImpact } from '../css/change-impact.js';
import { dashboardCss } from '../css.js';

const css = dashboardCss().replaceAll(/\s+/g, ' ');

describe('Change Impact stylesheet', () => {
  it('is composed after shared table primitives and before Code Paths styles', () => {
    expect(css.indexOf('/* Table */')).toBeLessThan(css.indexOf('/* ====== Change Impact report'));
    expect(css.indexOf('/* ====== Change Impact report')).toBeLessThan(
      css.indexOf('/* ====== Code Paths panel'),
    );
  });

  it('styles the primary report layouts and bounded entity tables', () => {
    expect(css).toContain('.change-impact-hero { display: grid;');
    expect(css).toContain('.change-impact-counts { display: grid;');
    expect(css).toContain('.change-impact-facts { display: grid;');
    expect(css).toContain('.change-impact-risk { display: grid;');
    expect(css).toContain('.change-impact-section .data-table { min-width: 680px; }');
    expect(css).toContain('.change-impact-section .card { max-width: 100%; overflow-x: auto; }');
  });

  it('uses textual state markers and theme variables rather than hardcoded status colours', () => {
    const concern = dashboardCssChangeImpact();
    expect(concern).toContain('.change-impact-verdict-pass::before { content: "✓ "; }');
    expect(concern).toContain('.change-impact-verdict-warn::before { content: "! "; }');
    expect(concern).toContain('.change-impact-verdict-fail::before { content: "× "; }');
    expect(concern).toContain('color: var(--success);');
    expect(concern).toContain('color: var(--warning);');
    expect(concern).toContain('color: var(--error);');
    expect(concern).not.toMatch(/#[\da-f]{3,8}\b/iu);
  });

  it('provides keyboard focus, narrow viewport, and reduced-motion rules', () => {
    expect(css).toContain('.tab:focus-visible, #change-impact-run-select:focus-visible,');
    expect(css).toContain('@media (max-width: 720px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain('.tab-bar { overflow-x: auto;');
    expect(css).toContain('outline: 2px solid var(--accent);');
  });
});
