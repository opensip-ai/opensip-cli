/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { generateDashboardHtml } from '../generator.js';

import type { GraphCatalog, StoredSession } from '@opensip-cli/contracts';

const minimalCatalog: GraphCatalog = {
  version: '2.0',
  tool: 'graph',
  language: 'typescript',
  builtAt: '2026-06-24T00:00:00Z',
  functions: {
    foo: [
      {
        bodyHash: 'h1',
        simpleName: 'foo',
        qualifiedName: 'pkg.foo',
        filePath: 'packages/x/src/foo.ts',
        line: 1,
        column: 0,
        endLine: 5,
        kind: 'function-declaration',
        params: [],
        returnType: null,
        enclosingClass: null,
        decorators: [],
        visibility: 'exported',
        inTestFile: false,
        definedInGenerated: false,
        calls: [],
      },
    ],
  },
};

const graphSession: StoredSession = {
  id: 'graph-session',
  tool: 'graph',
  startedAt: '2026-07-19T12:00:00.000Z',
  completedAt: '2026-07-19T12:00:01.000Z',
  cwd: '/repo',
  score: 100,
  passed: true,
  durationMs: 1000,
  payload: {
    summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0 },
    checks: [],
  },
};

function bootReport(html: string): void {
  document.documentElement.innerHTML = html
    .replace(/^[\s\S]*?<html[^>]*>/i, '')
    .replace(/<\/html>[\s\S]*$/i, '');
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
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: our own emitted HTML.
  new Function(combined).call(globalThis);
}

describe('dashboard hash init', () => {
  beforeEach(() => {
    globalThis.history.replaceState(null, '', '/latest.html');
  });

  it('leaves the URL hash empty when the report opens without a deep link', () => {
    const html = generateDashboardHtml({ sessions: [], graphCatalog: minimalCatalog });
    bootReport(html);
    expect(globalThis.location.hash).toBe('');
  });

  it('honours an existing #code-paths deep link on load', () => {
    globalThis.history.replaceState(null, '', '/latest.html#code-paths/distribution');
    const html = generateDashboardHtml({ sessions: [], graphCatalog: minimalCatalog });
    bootReport(html);
    expect(globalThis.location.hash).toBe('#code-paths/distribution');
  });

  it('rejects unknown and prefix-lookalike Code Paths hashes without blanking Overview', () => {
    for (const hash of ['#code-paths/not-a-view', '#code-paths/distribution/extra']) {
      globalThis.history.replaceState(null, '', '/latest.html' + hash);
      const html = generateDashboardHtml({ sessions: [], graphCatalog: minimalCatalog });
      bootReport(html);
      expect(document.querySelector('#panel-overview')?.classList.contains('active')).toBe(true);
      expect(document.querySelector('#panel-code-paths')?.classList.contains('active')).toBe(false);
    }
  });

  it('clears a Code Paths deep link when the reader leaves that top-level tab', () => {
    globalThis.history.replaceState(null, '', '/latest.html#code-paths/distribution');
    const html = generateDashboardHtml({ sessions: [], graphCatalog: minimalCatalog });
    bootReport(html);

    document.querySelector<HTMLButtonElement>('[data-tab="overview"]')?.click();

    expect(globalThis.location.hash).toBe('');
    expect(document.querySelector('#panel-overview')?.classList.contains('active')).toBe(true);
  });

  it('clears a Code Paths deep link during programmatic top-level navigation', () => {
    globalThis.history.replaceState(null, '', '/latest.html#code-paths/distribution');
    const html = generateDashboardHtml({ sessions: [], graphCatalog: minimalCatalog });
    bootReport(html);

    (
      globalThis as typeof globalThis & {
        activateReportTab: (id: string) => boolean;
      }
    ).activateReportTab('fitness');

    expect(globalThis.location.hash).toBe('');
    expect(document.querySelector('#panel-fitness')?.classList.contains('active')).toBe(true);
  });

  it('clears a Code Paths view hash when the reader leaves the Explore subtab', () => {
    globalThis.history.replaceState(null, '', '/latest.html#code-paths/distribution');
    const html = generateDashboardHtml({ sessions: [], graphCatalog: minimalCatalog });
    bootReport(html);

    document
      .querySelector<HTMLElement>('#panel-code-paths .subtab[data-subtab="catalog"]')
      ?.click();

    expect(globalThis.location.hash).toBe('');
    expect(
      document
        .querySelector('#panel-code-paths .subtab[data-subtab="catalog"]')
        ?.classList.contains('active'),
    ).toBe(true);
  });

  it('opens a graph session with only the Sessions subtab active', () => {
    const html = generateDashboardHtml({
      sessions: [graphSession],
      graphCatalog: minimalCatalog,
      graphRuleCatalog: [{ slug: 'graph:cycle', defaultSeverity: 'warning', source: 'built-in' }],
    });
    bootReport(html);
    document
      .querySelector<HTMLElement>('#panel-code-paths .subtab[data-subtab="catalog"]')
      ?.click();
    expect(
      document
        .querySelector('#panel-code-paths .subtab[data-subtab="catalog"]')
        ?.classList.contains('active'),
    ).toBe(true);

    (
      globalThis as typeof globalThis & {
        openCodePathsSession: (sessionId: string) => void;
      }
    ).openCodePathsSession(graphSession.id);

    const activeSubtabs = [
      ...document.querySelectorAll<HTMLElement>('#panel-code-paths .subtab.active'),
    ].map((tab) => tab.dataset.subtab);
    const activePanels = [
      ...document.querySelectorAll<HTMLElement>('#panel-code-paths .subtab-panel.active'),
    ].map((panel) => panel.id);
    expect(activeSubtabs).toEqual(['sessions']);
    expect(activePanels).toEqual(['panel-code-paths-sessions']);
  });

  it('matches persisted session ids without constructing a CSS selector', () => {
    const html = generateDashboardHtml({
      sessions: [graphSession],
      graphCatalog: minimalCatalog,
    });
    bootReport(html);

    expect(() =>
      (
        globalThis as typeof globalThis & {
          openCodePathsSession: (sessionId: string) => void;
        }
      ).openCodePathsSession('graph-session"]'),
    ).not.toThrow();
  });

  it('renders a visible state when exact function navigation misses the current catalog', () => {
    const html = generateDashboardHtml({ sessions: [], graphCatalog: minimalCatalog });
    bootReport(html);

    (
      globalThis as typeof globalThis & {
        openCodePathsFunction: (identity: {
          bodyHash: string;
          qualifiedName: string;
          filePath: string;
          line: number;
        }) => void;
      }
    ).openCodePathsFunction({
      bodyHash: 'missing',
      qualifiedName: 'pkg.missing',
      filePath: 'packages/x/src/missing.ts',
      line: 1,
    });

    expect(document.querySelector('#panel-code-paths')?.classList.contains('active')).toBe(true);
    expect(document.querySelector('#panel-code-paths-explore')?.textContent).toContain(
      'This function is not present as one exact occurrence in the current graph catalog.',
    );
  });
});
