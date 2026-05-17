/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * Function Card overlay behavior tests. Loads the emitted JS from the
 * indexes + function-card + function-row + path-utils + editor-link +
 * trace + filters + views-registry modules into a jsdom global, then
 * exercises the public API (openFunctionCard, closeFunctionCard).
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { dashboardEditorLinkJs } from '../persistence/dashboard/code-paths/editor-link.js';
import { dashboardFiltersJs } from '../persistence/dashboard/code-paths/filters.js';
import { dashboardFunctionCardJs } from '../persistence/dashboard/code-paths/function-card.js';
import { dashboardIndexesJs } from '../persistence/dashboard/code-paths/indexes.js';
import { dashboardPathUtilsJs } from '../persistence/dashboard/code-paths/path-utils.js';
import { dashboardTraceJs } from '../persistence/dashboard/code-paths/trace.js';

import type { GraphCatalog, GraphFunctionOccurrence } from '../persistence/dashboard/code-paths/types.js';

function makeOcc(over: Partial<GraphFunctionOccurrence> & { bodyHash: string; simpleName: string }): GraphFunctionOccurrence {
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
  // The emitted JS expects an `el(tag, attrs, children)` helper to exist
  // in scope (provided by shared.ts). We provide a minimal compatible
  // version for the test environment.
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
`;
  const editorProtocolSrc = `var EDITOR_PROTOCOL = null;`;
  const tail = `
var graphCatalog = ${JSON.stringify(catalog)};
var graphIndexes = buildIndexes(graphCatalog);
window.openFunctionCard = openFunctionCard;
window.closeFunctionCard = closeFunctionCard;
window.graphIndexes = graphIndexes;
`;
  const src = [
    elSrc,
    editorProtocolSrc,
    dashboardPathUtilsJs(),
    dashboardIndexesJs(),
    dashboardFiltersJs(),
    dashboardEditorLinkJs(),
    dashboardTraceJs(),
    dashboardFunctionCardJs(),
    tail,
  ].join('\n');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: our own emitter.
  new Function(src).call(globalThis);
}

interface DashboardWindow extends Window {
  openFunctionCard: (h: string) => void;
  closeFunctionCard: () => void;
  graphIndexes: { callers: Map<string, string[]>; byBodyHash: Map<string, GraphFunctionOccurrence> };
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
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: { resolveProjectPaths: [makeOcc({ bodyHash: 'h1', simpleName: 'resolveProjectPaths', filePath: 'packages/core/src/lib/paths.ts', line: 78, endLine: 96 })] },
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
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: { format: [makeOcc({ bodyHash: 'm1', simpleName: 'format', kind: 'method', enclosingClass: 'Logger' })] },
    });
    w().openFunctionCard('m1');
    expect(document.querySelector('.function-card-overlay')!.textContent).toContain('method');
  });

  it('renders an arrow shape', () => {
    bootDashboard({
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: { '<arrow:foo.ts:1:1>': [makeOcc({ bodyHash: 'a1', simpleName: '<arrow:foo.ts:1:1>', kind: 'arrow' })] },
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
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
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
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: {
        target: [makeOcc({ bodyHash: 't1', simpleName: 'target' })],
        a: [makeOcc({ bodyHash: 'ca', simpleName: 'a', filePath: 'packages/cli/src/a.ts', calls: [{ to: ['t1'], line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'target()' }] })],
        b: [makeOcc({ bodyHash: 'cb', simpleName: 'b', filePath: 'packages/cli/src/b.ts', calls: [{ to: ['t1'], line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'target()' }] })],
        c: [makeOcc({ bodyHash: 'cc', simpleName: 'c', filePath: 'packages/contracts/src/c.ts', calls: [{ to: ['t1'], line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'target()' }] })],
        d: [makeOcc({ bodyHash: 'cd', simpleName: 'd', filePath: 'packages/contracts/src/d.ts', calls: [{ to: ['t1'], line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'target()' }] })],
        e: [makeOcc({ bodyHash: 'ce', simpleName: 'e', filePath: 'packages/contracts/src/e.ts', calls: [{ to: ['t1'], line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'target()' }] })],
        f: [makeOcc({ bodyHash: 'cf', simpleName: 'f', filePath: 'packages/contracts/src/f.ts', calls: [{ to: ['t1'], line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'target()' }] })],
        g: [makeOcc({ bodyHash: 'cg', simpleName: 'g', filePath: 'packages/contracts/src/g.ts', calls: [{ to: ['t1'], line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'target()' }] })],
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
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: { lonely: [makeOcc({ bodyHash: 'l1', simpleName: 'lonely' })] },
    });
    w().openFunctionCard('l1');
    expect(document.querySelector('.function-card-overlay')!.textContent).toContain('No callers in catalog.');
  });

  it('shows polymorphic callees as three resolved entries', () => {
    bootDashboard({
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: {
        f: [makeOcc({ bodyHash: 'fh', simpleName: 'f', calls: [{ to: ['h1', 'h2', 'h3'], line: 2, column: 0, resolution: 'method-dispatch', confidence: 'medium', text: 'x.foo()' }] })],
        a: [makeOcc({ bodyHash: 'h1', simpleName: 'a' })],
        b: [makeOcc({ bodyHash: 'h2', simpleName: 'b' })],
        c: [makeOcc({ bodyHash: 'h3', simpleName: 'c' })],
      },
    });
    w().openFunctionCard('fh');
    const list = document.querySelectorAll('.function-card .fc-section')[1].querySelectorAll('li[data-body-hash]');
    expect(list.length).toBe(3);
  });

  it('opening a caller swaps the overlay content (recursion uses a single overlay)', () => {
    bootDashboard({
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: {
        target: [makeOcc({ bodyHash: 't1', simpleName: 'target' })],
        caller: [makeOcc({ bodyHash: 'cr', simpleName: 'caller', calls: [{ to: ['t1'], line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'target()' }] })],
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
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: { f: [makeOcc({ bodyHash: 'h', simpleName: 'f' })] },
    });
    w().openFunctionCard('h');
    expect(document.querySelector('.function-card-overlay')).not.toBeNull();
    w().closeFunctionCard();
    expect(document.querySelector('.function-card-overlay')).toBeNull();
  });

  it('clicking the overlay backdrop closes the card', () => {
    bootDashboard({
      version: '2.0', tool: 'graph', language: 'typescript', builtAt: 'now',
      functions: { f: [makeOcc({ bodyHash: 'h', simpleName: 'f' })] },
    });
    w().openFunctionCard('h');
    const overlay = document.querySelector('.function-card-overlay')!;
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.function-card-overlay')).toBeNull();
  });
});
