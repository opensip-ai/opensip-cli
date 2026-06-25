/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { generateDashboardHtml } from '../generator.js';

import type { GraphCatalog } from '@opensip-cli/contracts';

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
});
