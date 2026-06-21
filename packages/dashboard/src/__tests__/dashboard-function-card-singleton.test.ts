/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * §10.2 invariant: at most one .function-card-overlay element exists
 * in the DOM at any moment, even when opening cards in rapid
 * succession.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { DASHBOARD_CLIENT_BUNDLE } from '../client-bundle.generated.js';

import type { GraphCatalog, GraphFunctionOccurrence } from '@opensip-cli/contracts';

interface Env {
  open: (h: string) => void;
}

function makeOcc(
  over: Partial<GraphFunctionOccurrence> & { bodyHash: string; simpleName: string },
): GraphFunctionOccurrence {
  return {
    qualifiedName: over.simpleName,
    filePath: 'packages/x/src/x.ts',
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
    ...over,
  };
}

function loadEnv(catalog: GraphCatalog): Env {
  // `openFunctionCard` (with `el`, `buildIndexes`, `editorLinkUrl`, `traceFromEntry`,
  // path-utils) now lives in the typed client bundle (L4) and is exposed as a page
  // global; it reads the `graphCatalog` / `graphIndexes` page globals as free
  // identifiers. Declare those (plus `EDITOR_PROTOCOL` and `sessions`) in the eval
  // scope so the bundle's IIFE closes over them; the tail seeds graphCatalog /
  // graphIndexes after the bundle has defined `buildIndexes`.
  const head = `
var sessions = [];
var EDITOR_PROTOCOL = null;
var graphCatalog = null;
var graphIndexes = null;
`;
  const tail = `
graphCatalog = ${JSON.stringify(catalog)};
graphIndexes = buildIndexes(graphCatalog);
return { open: openFunctionCard };
`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: our own bundled dashboard JS.
  return new Function(head + DASHBOARD_CLIENT_BUNDLE + tail)() as Env;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Function Card singleton — §10.2', () => {
  it('opening three cards in succession leaves exactly one overlay in the DOM', () => {
    const env = loadEnv({
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        a: [makeOcc({ bodyHash: 'ha', simpleName: 'a' })],
        b: [makeOcc({ bodyHash: 'hb', simpleName: 'b' })],
        c: [makeOcc({ bodyHash: 'hc', simpleName: 'c' })],
      },
    });
    env.open('ha');
    env.open('hb');
    env.open('hc');
    const overlays = document.querySelectorAll('.function-card-overlay');
    expect(overlays.length).toBe(1);
    expect(overlays[0].textContent).toContain('c');
  });
});
