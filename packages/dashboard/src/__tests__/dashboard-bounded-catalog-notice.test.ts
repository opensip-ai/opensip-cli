/**
 * @vitest-environment jsdom
 *
 * When the inlined catalog is truncated, the report must SAY so — and say what
 * to type next.
 *
 * A report that quietly rendered 5,000 of 32,000 functions would look complete,
 * which is the exact failure this product exists to prevent ("an empty result is
 * not a clean result"). And the escape hatch has to live where the reader
 * notices something is missing: a config key they would need to already know
 * about is not a discovery surface, so the notice names the command.
 */

import { describe, expect, it } from 'vitest';

import { generateDashboardHtml } from '../generator.js';

import type { GraphCatalog } from '@opensip-cli/contracts';

function catalogWith(functionCount: number): GraphCatalog {
  const functions: Record<string, unknown[]> = {};
  for (let i = 0; i < functionCount; i++) {
    const hash = `h${String(i).padStart(5, '0')}`;
    functions[hash] = [
      {
        bodyHash: hash,
        simpleName: `fn_${hash}`,
        qualifiedName: `pkg/mod#fn_${hash}`,
        filePath: `src/${hash}.ts`,
        package: 'pkg',
        line: 1,
        endLine: 40,
        column: 0,
        kind: 'function',
        inTestFile: false,
        calls: [],
      },
    ];
  }
  return {
    version: '2.0',
    language: 'typescript',
    cacheKey: 'eng=1|mode=exact',
    builtAt: new Date(0).toISOString(),
    resolutionMode: 'exact',
    functions,
    features: { function: {}, edge: [], package: {}, scc: [] },
  } as unknown as GraphCatalog;
}

/** Render the report and activate Code Paths → Explore, where the bar lives. */
function bootExplore(html: string): void {
  document.documentElement.innerHTML = html
    .replace(/^[\s\S]*?<html[^>]*>/iu, '')
    .replace(/<\/html>[\s\S]*$/iu, '');
  let combined = '';
  for (const script of document.querySelectorAll('script')) {
    const type = script.getAttribute('type');
    // The catalog blobs are application/json — executing them as JS would throw.
    if (type && type !== 'text/javascript' && type !== '') continue;
    if (script.textContent) combined += `\n${script.textContent}`;
  }
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- our own generated report, under test.
  new Function(combined).call(globalThis);
  document.querySelector<HTMLElement>('[data-tab="code-paths"]')?.click();
  document.querySelector<HTMLElement>('#panel-code-paths .subtab[data-subtab="explore"]')?.click();
}

describe('bounded-catalog notice', () => {
  it('states how many functions were dropped, and names the command to get them all', () => {
    const html = generateDashboardHtml({
      sessions: [],
      graphCatalog: catalogWith(400),
      // Far below what 400 functions need, so truncation is guaranteed.
      maxGraphCatalogBytes: 20_000,
    });

    bootExplore(html);

    const bar = document.querySelector('.catalog-provenance');
    expect(bar?.textContent).toContain('of 400 (bounded)');

    const hint = document.querySelector('.catalog-bounded-hint');
    expect(hint?.textContent).toContain('opensip report --max-catalog-mb');
    expect(hint?.textContent).toContain('for the full catalog');
  });

  it('says nothing when the whole catalog fits — no notice on a complete report', () => {
    const html = generateDashboardHtml({
      sessions: [],
      graphCatalog: catalogWith(5),
    });

    bootExplore(html);

    expect(document.querySelector('.catalog-bounded-hint')).toBeNull();
    expect(document.querySelector('.catalog-provenance')?.textContent).not.toContain('bounded');
  });

  it('honours a raised budget: the same catalog renders complete and unannotated', () => {
    const html = generateDashboardHtml({
      sessions: [],
      graphCatalog: catalogWith(400),
      maxGraphCatalogBytes: 64 * 1024 * 1024,
    });

    bootExplore(html);

    expect(document.querySelector('.catalog-bounded-hint')).toBeNull();
    expect(document.querySelector('.catalog-provenance')?.textContent).toContain('400');
  });
});
