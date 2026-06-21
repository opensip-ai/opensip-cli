/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * Editor deep-link URL generator tests.
 *
 * `editorLinkUrl` is a module-internal prelude helper in the typed client bundle
 * (L4) — NOT a page global. Its sole consumer is the Function Card's action row
 * (an "Open in editor" anchor when the URL resolves, a "Copy path" button
 * otherwise), so the test drives it through that public surface: define the
 * `EDITOR_PROTOCOL` page global, boot the bundle (which exposes `openFunctionCard`
 * / `buildIndexes`), open a card, and read the resulting anchor href.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { DASHBOARD_CLIENT_BUNDLE } from '../client-bundle.generated.js';

import type { GraphCatalog } from '@opensip-cli/contracts';

interface DashboardWindow extends Window {
  openFunctionCard: (h: string) => void;
}

const CATALOG: GraphCatalog = {
  version: '2.0',
  tool: 'graph',
  language: 'typescript',
  builtAt: 'now',
  functions: {
    f: [
      {
        qualifiedName: 'f',
        simpleName: 'f',
        bodyHash: 'h1',
        filePath: 'packages/x/src/x.ts',
        line: 42,
        column: 0,
        endLine: 50,
        kind: 'function-declaration',
        params: [],
        returnType: null,
        enclosingClass: null,
        decorators: [],
        visibility: 'exported',
        inTestFile: false,
        definedInGenerated: false,
        calls: [],
      } as unknown as GraphCatalog['functions'][string][number],
    ],
  },
};

/** Boot the bundle with the given EDITOR_PROTOCOL, open the card for h1, return its action anchor href (or null). */
function editorHref(protocol: string | null, line = 42): string | null {
  document.body.innerHTML = '';
  const protoSrc =
    protocol === null
      ? 'var EDITOR_PROTOCOL = null;'
      : 'var EDITOR_PROTOCOL = ' + JSON.stringify(protocol) + ';';
  const cat: GraphCatalog = {
    ...CATALOG,
    functions: {
      f: [{ ...CATALOG.functions.f[0], line }],
    },
  };
  const head =
    'var sessions = [];\n' + protoSrc + '\nvar graphCatalog = null;\nvar graphIndexes = null;\n';
  const tail = `
graphCatalog = ${JSON.stringify(cat)};
graphIndexes = buildIndexes(graphCatalog);
globalThis.openFunctionCard = openFunctionCard;
`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: our own bundled dashboard JS.
  new Function(head + DASHBOARD_CLIENT_BUNDLE + tail).call(globalThis);
  (globalThis as unknown as DashboardWindow).openFunctionCard('h1');
  const anchor = document.querySelector<HTMLAnchorElement>('.fc-actions a.fc-action');
  return anchor ? anchor.getAttribute('href') : null;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('editorLinkUrl (via the Function Card action row)', () => {
  it('produces vscode://file/<path>:<line> for vscode', () => {
    expect(editorHref('vscode', 42)).toBe('vscode://file/packages/x/src/x.ts:42');
  });

  it('produces cursor://file/<path>:<line> for cursor', () => {
    expect(editorHref('cursor', 7)).toBe('cursor://file/packages/x/src/x.ts:7');
  });

  it('renders no editor anchor (Copy path fallback) when EDITOR_PROTOCOL is null', () => {
    expect(editorHref(null)).toBeNull();
    // The fallback is a Copy path button, not an anchor.
    expect(document.querySelector('.fc-actions button.fc-action')?.textContent).toBe('Copy path');
  });

  it('renders no editor anchor for an unrecognized protocol', () => {
    expect(editorHref('mystery')).toBeNull();
  });
});
