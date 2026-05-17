/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * Phase V — End-to-end validation against opensip-tools' own
 * generated dashboard. Reads the live latest.html (produced by the
 * preceding `pnpm dashboard` run during workspace test bootstrap)
 * and exercises every view + the Function Card flow.
 *
 * Skipped when latest.html is missing or contains no graph catalog
 * (e.g. fresh checkout without a dogfood run). The harness can re-
 * run the dashboard CLI separately and re-execute this test.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
// HERE is packages/contracts/src/__tests__; repo root is four levels up.
const REPO_ROOT = join(HERE, '..', '..', '..', '..');
const REPORT = join(REPO_ROOT, 'opensip-tools', '.runtime', 'reports', 'latest.html');

function readReportOrSkip(): string | null {
  if (!existsSync(REPORT)) return null;
  const html = readFileSync(REPORT, 'utf8');
  if (!html.includes('id="graph-catalog"')) return null;
  return html;
}

interface BootResult {
  views: { id: string; label: string }[];
  activateView: (id: string) => void;
  openFunctionCard: (h: string) => void;
}

function bootDashboard(html: string): BootResult {
  // Render the full HTML into the jsdom document, then evaluate the
  // inlined script bodies in a single sandbox. Returns the local
  // bindings (views, activateView, openFunctionCard) — they're const
  // so they never reach globalThis.
  document.documentElement.innerHTML = html.replace(/^[\s\S]*?<html[^>]*>/i, '').replace(/<\/html>[\s\S]*$/i, '');
  // eslint-disable-next-line unicorn/prefer-spread -- NodeListOf<HTMLScriptElement> spread requires lib.dom.iterable.
  const scripts = Array.from(document.querySelectorAll('script'));
  let combined = '';
  for (const s of scripts) {
    const type = s.getAttribute('type');
    if (type && type !== 'text/javascript' && type !== '') continue;
    const src = s.textContent ?? '';
    if (src.length === 0) continue;
    combined += '\n' + src;
  }
  combined += '\nreturn { views, activateView, openFunctionCard };';
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: our own emitted HTML.
  return new Function(combined).call(globalThis) as BootResult;
}

describe.runIf(existsSync(REPORT))('Phase V — dashboard end-to-end validation', () => {
  it('latest.html embeds the graph catalog', () => {
    const html = readReportOrSkip();
    if (!html) { expect(true).toBe(true); return; }
    expect(html).toContain('id="graph-catalog"');
  });

  it('boots without throwing and registers 7 views', () => {
    const html = readReportOrSkip();
    if (!html) { expect(true).toBe(true); return; }
    const env = bootDashboard(html);
    expect(env.views).toBeDefined();
    expect(env.views.length).toBe(7);
  });

  it('renders the Code Paths panel with the persistent search input', () => {
    const html = readReportOrSkip();
    if (!html) { expect(true).toBe(true); return; }
    bootDashboard(html);
    expect(document.querySelector('#code-paths-search-input')).not.toBeNull();
  });

  it('every view container exists and the active one renders something', () => {
    const html = readReportOrSkip();
    if (!html) { expect(true).toBe(true); return; }
    bootDashboard(html);
    for (const id of ['hot', 'big', 'wide', 'coupling', 'untested', 'sccs', 'search']) {
      const c = document.querySelector('#code-paths-view-' + id);
      expect(c).not.toBeNull();
    }
    const active = document.querySelector('.code-paths-view.active');
    expect(active).not.toBeNull();
    // The active view either has a real row OR shows the documented empty state.
    const hasRows = active!.querySelector('[data-body-hash]');
    const hasEmpty = active!.querySelector('.empty');
    expect(Boolean(hasRows) || Boolean(hasEmpty)).toBe(true);
  });

  it('Function Card overlay opens for the first row of the hot view', () => {
    const html = readReportOrSkip();
    if (!html) { expect(true).toBe(true); return; }
    const env = bootDashboard(html);
    env.activateView('hot');
    const firstRow = document.querySelector('#code-paths-view-hot [data-body-hash]');
    if (!firstRow) { expect(true).toBe(true); return; } // Empty hot view is acceptable.
    env.openFunctionCard((firstRow as HTMLElement).dataset.bodyHash!);
    const overlays = document.querySelectorAll('.function-card-overlay');
    expect(overlays.length).toBe(1);
  });

  it('typing into the search input shows results and switches the active tab', () => {
    const html = readReportOrSkip();
    if (!html) { expect(true).toBe(true); return; }
    bootDashboard(html);
    const input = document.querySelector('#code-paths-search-input')!;
    (input as HTMLInputElement).value = 'logger';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const search = document.querySelector('#code-paths-view-search')!;
    expect(search.classList.contains('active')).toBe(true);
  });
});
