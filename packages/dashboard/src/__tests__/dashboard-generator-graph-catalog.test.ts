/**
 * Generator-level wiring tests for the v0.3 graph-catalog inline blob
 * and the editor-protocol JS constant.
 *
 * Covers Phase P0 (catalog block emission, null vs non-null) and the
 * Phase P9 hook (editor protocol constant).
 */

import { describe, expect, it } from 'vitest';

import { generateDashboardHtml } from '../generator.js';

import type { GraphCatalog } from '@opensip-tools/contracts';

const minimalCatalog: GraphCatalog = {
  version: '2.0',
  tool: 'graph',
  language: 'typescript',
  builtAt: '2026-05-17T00:00:00Z',
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

describe('generateDashboardHtml — graph catalog wiring', () => {
  it('emits no id="graph-catalog" block when graphCatalog is null', () => {
    const html = generateDashboardHtml({ sessions: [], graphCatalog: null });
    expect(html).not.toContain('id="graph-catalog"');
  });

  it('emits the graph-catalog blob and is parseable JSON when supplied', () => {
    const html = generateDashboardHtml({ sessions: [], graphCatalog: minimalCatalog });
    expect(html).toContain('id="graph-catalog"');

    // Pull out the blob and re-parse it.
    const m = /<script type="application\/json" id="graph-catalog">([\s\S]*?)<\/script>/.exec(html);
    expect(m).not.toBeNull();
    const blob = m![1];
    // Reverse the < / > escape that escapeForScriptContext applies.
    const unescaped = blob.replaceAll(String.raw`<`, '<').replaceAll(String.raw`>`, '>');
    const parsed = JSON.parse(unescaped) as GraphCatalog;
    expect(parsed.version).toBe('2.0');
    expect(Object.keys(parsed.functions)).toContain('foo');
  });

  it('embeds EDITOR_PROTOCOL = null when no editorProtocol is supplied', () => {
    const html = generateDashboardHtml({ sessions: [], graphCatalog: null });
    expect(html).toContain('const EDITOR_PROTOCOL = null;');
  });

  it('embeds EDITOR_PROTOCOL as a JS string constant when supplied', () => {
    const html = generateDashboardHtml({ sessions: [], graphCatalog: minimalCatalog, editorProtocol: 'vscode' });
    expect(html).toContain('const EDITOR_PROTOCOL = "vscode";');
  });

  it('embeds the restructured view ids via the views[] registry', () => {
    const html = generateDashboardHtml({ sessions: [], graphCatalog: minimalCatalog });
    for (const id of ['graph', 'coupling', 'search', 'distribution']) {
      expect(html).toContain(`id: '${id}'`);
    }
  });
});
