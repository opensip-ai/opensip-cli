/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * §10.2 invariant: at most one .function-card-overlay element exists
 * in the DOM at any moment, even when opening cards in rapid
 * succession.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { dashboardEditorLinkJs } from '../code-paths/editor-link.js';
import { dashboardFunctionCardJs } from '../code-paths/function-card.js';
import { dashboardIndexesJs } from '../code-paths/indexes.js';
import { dashboardPathUtilsJs } from '../code-paths/path-utils.js';
import { dashboardTraceJs } from '../code-paths/trace.js';

import type { GraphCatalog, GraphFunctionOccurrence } from '@opensip-tools/contracts';

interface Env {
  open: (h: string) => void;
}

function makeOcc(over: Partial<GraphFunctionOccurrence> & { bodyHash: string; simpleName: string }): GraphFunctionOccurrence {
  return {
    qualifiedName: over.simpleName, filePath: 'packages/x/src/x.ts', line: 1, column: 0, endLine: 5,
    kind: 'function-declaration', params: [], returnType: null, enclosingClass: null,
    decorators: [], visibility: 'exported', inTestFile: false, definedInGenerated: false, calls: [],
    ...over,
  };
}

function loadEnv(catalog: GraphCatalog): Env {
  const elSrc = `
function el(tag, attrs, children) {
  const e = document.createElement(tag);
  if (attrs) Object.entries(attrs).forEach(([k,v]) => {
    if (k === 'text') e.textContent = v;
    else if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  });
  if (children) children.forEach(c => { if (typeof c === 'string') e.appendChild(document.createTextNode(c)); else if (c) e.appendChild(c); });
  return e;
}
var EDITOR_PROTOCOL = null;
`;
  const tail = `
var graphCatalog = ${JSON.stringify(catalog)};
var graphIndexes = buildIndexes(graphCatalog);
return { open: openFunctionCard };
`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source.
  return new Function(
    elSrc
      + dashboardPathUtilsJs()
      + dashboardIndexesJs()
      + dashboardEditorLinkJs()
      + dashboardTraceJs()
      + dashboardFunctionCardJs()
      + tail,
  )() as Env;
}

beforeEach(() => { document.body.innerHTML = ''; });

describe('Function Card singleton — §10.2', () => {
  it('opening three cards in succession leaves exactly one overlay in the DOM', () => {
    const env = loadEnv({
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
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
