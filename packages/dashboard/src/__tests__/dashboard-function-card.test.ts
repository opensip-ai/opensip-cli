/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * Function Card overlay behavior tests. Loads the typed client bundle (L4) —
 * which carries indexes + function-card + path-utils + editor-link + trace —
 * into the jsdom global scope, then exercises the public API (openFunctionCard,
 * closeFunctionCard, both exposed as page globals).
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { DASHBOARD_CLIENT_BUNDLE } from '../client-bundle.generated.js';

import type { GraphCatalog, GraphFunctionOccurrence } from '@opensip-cli/contracts';

function makeOcc(
  over: Partial<GraphFunctionOccurrence> & { bodyHash: string; simpleName: string },
): GraphFunctionOccurrence {
  return {
    qualifiedName: over.simpleName,
    filePath: 'packages/x/src/x.ts',
    line: 10,
    column: 0,
    endLine: 30,
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

function bootDashboard(catalog: GraphCatalog): void {
  // The bundle (with `el`, `buildIndexes`, `editorLinkUrl`, `traceFromEntry`,
  // path-utils, function-card) exposes openFunctionCard / closeFunctionCard on
  // globalThis. It reads `graphCatalog` / `graphIndexes` as free identifiers;
  // declare them (plus `EDITOR_PROTOCOL`, `sessions`) in the eval scope so the
  // bundle's IIFE closes over them, then seed graphCatalog / graphIndexes after
  // the bundle has defined `buildIndexes` and re-expose them on globalThis.
  const head = `
var sessions = [];
var EDITOR_PROTOCOL = null;
var graphCatalog = null;
var graphIndexes = null;
`;
  const tail = `
graphCatalog = ${JSON.stringify(catalog)};
graphIndexes = buildIndexes(graphCatalog);
globalThis.openFunctionCard = openFunctionCard;
globalThis.closeFunctionCard = closeFunctionCard;
globalThis.graphIndexes = graphIndexes;
`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: our own bundled dashboard JS.
  new Function(head + DASHBOARD_CLIENT_BUNDLE + tail).call(globalThis);
}

interface DashboardWindow extends Window {
  openFunctionCard: (h: string) => void;
  closeFunctionCard: () => void;
  graphIndexes: {
    callers: Map<string, string[]>;
    byBodyHash: Map<string, GraphFunctionOccurrence>;
  };
}

function w(): DashboardWindow {
  return globalThis as unknown as DashboardWindow;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('Function Card overlay', () => {
  it('opens with name + location for a function-declaration occurrence', () => {
    bootDashboard({
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        resolveProjectPaths: [
          makeOcc({
            bodyHash: 'h1',
            simpleName: 'resolveProjectPaths',
            filePath: 'packages/core/src/lib/paths.ts',
            line: 78,
            endLine: 96,
          }),
        ],
      },
    });
    w().openFunctionCard('h1');
    const overlay = document.querySelector('.function-card-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay!.textContent).toContain('resolveProjectPaths');
    expect(overlay!.textContent).toContain('packages/core/src/lib/paths.ts:78');
    expect(overlay!.textContent).toContain('function-declaration');
  });

  it('renders a method shape (kind=method) correctly', () => {
    bootDashboard({
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        format: [
          makeOcc({
            bodyHash: 'm1',
            simpleName: 'format',
            kind: 'method',
            enclosingClass: 'Logger',
          }),
        ],
      },
    });
    w().openFunctionCard('m1');
    expect(document.querySelector('.function-card-overlay')!.textContent).toContain('method');
  });

  it('renders an arrow shape', () => {
    bootDashboard({
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        '<arrow:foo.ts:1:1>': [
          makeOcc({ bodyHash: 'a1', simpleName: '<arrow:foo.ts:1:1>', kind: 'arrow' }),
        ],
      },
    });
    w().openFunctionCard('a1');
    const overlay = document.querySelector('.function-card-overlay')!;
    // Synthetic names are collapsed to just the kind tag in the card
    // header; the full simpleName never appears verbatim.
    expect(overlay.querySelector('.function-card h3')!.textContent).toBe('<arrow>');
    expect(overlay.textContent).not.toContain('<arrow:foo.ts:1:1>');
    // The kind label still surfaces in the meta row.
    expect(overlay.querySelector('.fc-meta')!.textContent).toContain('arrow');
  });

  it('renders a getter and constructor with the right kind label', () => {
    bootDashboard({
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        size: [makeOcc({ bodyHash: 'g1', simpleName: 'size', kind: 'getter' })],
        constructor: [makeOcc({ bodyHash: 'c1', simpleName: 'constructor', kind: 'constructor' })],
      },
    });
    w().openFunctionCard('g1');
    expect(document.querySelector('.function-card-overlay')!.textContent).toContain('getter');
    w().openFunctionCard('c1');
    expect(document.querySelector('.function-card-overlay')!.textContent).toContain('constructor');
  });

  it('groups callers by package and shows the right count', () => {
    bootDashboard({
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        target: [makeOcc({ bodyHash: 't1', simpleName: 'target' })],
        a: [
          makeOcc({
            bodyHash: 'ca',
            simpleName: 'a',
            filePath: 'packages/cli/src/a.ts',
            calls: [
              {
                to: ['t1'],
                line: 1,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: 'target()',
              },
            ],
          }),
        ],
        b: [
          makeOcc({
            bodyHash: 'cb',
            simpleName: 'b',
            filePath: 'packages/cli/src/b.ts',
            calls: [
              {
                to: ['t1'],
                line: 1,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: 'target()',
              },
            ],
          }),
        ],
        c: [
          makeOcc({
            bodyHash: 'cc',
            simpleName: 'c',
            filePath: 'packages/contracts/src/c.ts',
            calls: [
              {
                to: ['t1'],
                line: 1,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: 'target()',
              },
            ],
          }),
        ],
        d: [
          makeOcc({
            bodyHash: 'cd',
            simpleName: 'd',
            filePath: 'packages/contracts/src/d.ts',
            calls: [
              {
                to: ['t1'],
                line: 1,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: 'target()',
              },
            ],
          }),
        ],
        e: [
          makeOcc({
            bodyHash: 'ce',
            simpleName: 'e',
            filePath: 'packages/contracts/src/e.ts',
            calls: [
              {
                to: ['t1'],
                line: 1,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: 'target()',
              },
            ],
          }),
        ],
        f: [
          makeOcc({
            bodyHash: 'cf',
            simpleName: 'f',
            filePath: 'packages/contracts/src/f.ts',
            calls: [
              {
                to: ['t1'],
                line: 1,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: 'target()',
              },
            ],
          }),
        ],
        g: [
          makeOcc({
            bodyHash: 'cg',
            simpleName: 'g',
            filePath: 'packages/contracts/src/g.ts',
            calls: [
              {
                to: ['t1'],
                line: 1,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: 'target()',
              },
            ],
          }),
        ],
      },
    });
    w().openFunctionCard('t1');
    const text = document.querySelector('.function-card-overlay')!.textContent ?? '';
    expect(text).toContain('Callers (7)');
    expect(text).toContain('cli (2)');
    expect(text).toContain('contracts (5)');
  });

  it('shows "No callers in catalog." when there are zero callers', () => {
    bootDashboard({
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: { lonely: [makeOcc({ bodyHash: 'l1', simpleName: 'lonely' })] },
    });
    w().openFunctionCard('l1');
    expect(document.querySelector('.function-card-overlay')!.textContent).toContain(
      'No callers in catalog.',
    );
  });

  it('shows polymorphic callees as three resolved entries', () => {
    bootDashboard({
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        f: [
          makeOcc({
            bodyHash: 'fh',
            simpleName: 'f',
            calls: [
              {
                to: ['h1', 'h2', 'h3'],
                line: 2,
                column: 0,
                resolution: 'method-dispatch',
                confidence: 'medium',
                text: 'x.foo()',
              },
            ],
          }),
        ],
        a: [makeOcc({ bodyHash: 'h1', simpleName: 'a' })],
        b: [makeOcc({ bodyHash: 'h2', simpleName: 'b' })],
        c: [makeOcc({ bodyHash: 'h3', simpleName: 'c' })],
      },
    });
    w().openFunctionCard('fh');
    const list = document
      .querySelectorAll('.function-card .fc-section')[1]
      .querySelectorAll('li[data-body-hash]');
    expect(list.length).toBe(3);
  });

  it('opening a caller swaps the overlay content (recursion uses a single overlay)', () => {
    bootDashboard({
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        target: [makeOcc({ bodyHash: 't1', simpleName: 'target' })],
        caller: [
          makeOcc({
            bodyHash: 'cr',
            simpleName: 'caller',
            calls: [
              {
                to: ['t1'],
                line: 1,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: 'target()',
              },
            ],
          }),
        ],
      },
    });
    w().openFunctionCard('t1');
    expect(document.querySelectorAll('.function-card-overlay').length).toBe(1);
    w().openFunctionCard('cr');
    expect(document.querySelectorAll('.function-card-overlay').length).toBe(1);
    expect(document.querySelector('.function-card-overlay')!.textContent).toContain('caller');
  });

  it('closeFunctionCard removes the overlay node', () => {
    bootDashboard({
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: { f: [makeOcc({ bodyHash: 'h', simpleName: 'f' })] },
    });
    w().openFunctionCard('h');
    expect(document.querySelector('.function-card-overlay')).not.toBeNull();
    w().closeFunctionCard();
    expect(document.querySelector('.function-card-overlay')).toBeNull();
  });

  it('clicking the overlay backdrop closes the card', () => {
    bootDashboard({
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: { f: [makeOcc({ bodyHash: 'h', simpleName: 'f' })] },
    });
    w().openFunctionCard('h');
    const overlay = document.querySelector('.function-card-overlay')!;
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.function-card-overlay')).toBeNull();
  });
});
