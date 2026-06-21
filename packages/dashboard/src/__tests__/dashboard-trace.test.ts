/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * `traceFromEntry` BFS tests.
 *
 * `traceFromEntry` is a module-internal prelude helper in the typed client
 * bundle (L4) — NOT a page global. Its sole consumer is the Function Card's
 * "Trace from entry" action, so the test drives it through that public surface:
 * boot the bundle (which exposes `openFunctionCard` / `buildIndexes` as page
 * globals), open a card, click "Trace from entry", and read the rendered
 * `.fc-trace-result` path. `var sessions = []` / `var EDITOR_PROTOCOL = null`
 * satisfy the bundle's load-time reads; `graphCatalog` / `graphIndexes` are the
 * page globals the card reads.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { DASHBOARD_CLIENT_BUNDLE } from '../client-bundle.generated.js';

import type { GraphCatalog, GraphFunctionOccurrence } from '@opensip-cli/contracts';

interface DashboardWindow extends Window {
  openFunctionCard: (h: string) => void;
}

function boot(catalog: GraphCatalog): void {
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
`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: our own bundled dashboard JS.
  new Function(head + DASHBOARD_CLIENT_BUNDLE + tail).call(globalThis);
}

/** Open `targetHash`'s card, click "Trace from entry", return the rendered path's simpleNames. */
function tracePath(catalog: GraphCatalog, targetHash: string): string[] | null {
  document.body.innerHTML = '';
  boot(catalog);
  (globalThis as unknown as DashboardWindow).openFunctionCard(targetHash);
  const overlay = document.querySelector('.function-card-overlay');
  if (!overlay) return null;
  const traceBtn = [...overlay.querySelectorAll<HTMLButtonElement>('.fc-action')].find(
    (b) => b.textContent === 'Trace from entry',
  );
  if (!traceBtn) return null;
  traceBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const result = overlay.querySelector('.fc-trace-result');
  if (!result) return null;
  if (result.querySelector('.empty')) return null;
  return [...result.querySelectorAll('li[data-body-hash]')].map(
    (li) => (li as HTMLElement).dataset.bodyHash!,
  );
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

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('traceFromEntry (via the Function Card "Trace from entry" action)', () => {
  it('finds the shortest path from an entry to the target', () => {
    // entry (cli) → mid → target. Plus a longer path entry → a → b → mid.
    const cat: GraphCatalog = {
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        entry: [
          makeOcc({
            bodyHash: 'he',
            simpleName: 'entry',
            filePath: 'packages/cli/src/index.ts',
            calls: [
              {
                to: ['hm', 'ha'],
                line: 1,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: '...',
              },
            ],
          }),
        ],
        a: [
          makeOcc({
            bodyHash: 'ha',
            simpleName: 'a',
            calls: [
              {
                to: ['hb'],
                line: 1,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: 'b()',
              },
            ],
          }),
        ],
        b: [
          makeOcc({
            bodyHash: 'hb',
            simpleName: 'b',
            calls: [
              {
                to: ['hm'],
                line: 1,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: 'mid()',
              },
            ],
          }),
        ],
        mid: [
          makeOcc({
            bodyHash: 'hm',
            simpleName: 'mid',
            calls: [
              {
                to: ['ht'],
                line: 1,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: 'target()',
              },
            ],
          }),
        ],
        target: [makeOcc({ bodyHash: 'ht', simpleName: 'target' })],
      },
    };
    expect(tracePath(cat, 'ht')).toEqual(['he', 'hm', 'ht']);
  });

  it('renders the empty state when no entry reaches the target', () => {
    const cat: GraphCatalog = {
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        entry: [
          makeOcc({ bodyHash: 'he', simpleName: 'entry', filePath: 'packages/cli/src/index.ts' }),
        ],
        // 'target' is module-local with no callers reaching it from any entry.
        target: [makeOcc({ bodyHash: 'ht', simpleName: 'target', visibility: 'module-local' })],
      },
    };
    expect(tracePath(cat, 'ht')).toBeNull();
  });
});
