/// <reference lib="dom" />
/**
 * @vitest-environment jsdom
 *
 * View 4 (Package coupling) — N×N matrix + drilldown.
 */

import { describe, expect, it, beforeEach, vi } from 'vitest';

import { DASHBOARD_CLIENT_BUNDLE } from '../client-bundle.generated.js';

import type { GraphCatalog, GraphFunctionOccurrence } from '@opensip-cli/contracts';

interface Env {
  views: {
    id: string;
    render: (c: HTMLElement, cat: GraphCatalog, idx: unknown, fs: unknown) => void;
  }[];
  graphCatalog: GraphCatalog;
  graphIndexes: { byBodyHash: Map<string, GraphFunctionOccurrence> };
  filterState: { packages: Set<string>; kinds: Set<string>; includeTests: boolean };
}

function loadEnv(catalog: GraphCatalog): Env {
  // The coupling view (and the whole Code Paths panel + prelude) now lives in
  // the typed client bundle (L4): loading the bundle registers the view into the
  // bundle's `views` global at IIFE eval. Declare the page globals the bundle
  // reads (sessions, EDITOR_PROTOCOL, graphCatalog, graphIndexes); seed
  // graphCatalog/graphIndexes after the bundle has defined `buildIndexes`.
  const head = `
var sessions = [];
var EDITOR_PROTOCOL = null;
var graphCatalog = null;
var graphIndexes = null;
`;
  const tail = `
graphCatalog = ${JSON.stringify(catalog)};
graphIndexes = buildIndexes(graphCatalog);
return { views, graphCatalog, graphIndexes, filterState };
`;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source: our own bundled dashboard JS.
  const factory = new Function(head + DASHBOARD_CLIENT_BUNDLE + tail);
  return factory() as Env;
}

function makeOcc(
  over: Partial<GraphFunctionOccurrence> & {
    bodyHash: string;
    simpleName: string;
    filePath: string;
  },
): GraphFunctionOccurrence {
  return {
    qualifiedName: over.simpleName,
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

describe('View 4 — Coupling matrix', () => {
  it('renders an N×N matrix with the right cell counts for two packages', () => {
    const catalog: GraphCatalog = {
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        a: [
          makeOcc({
            bodyHash: 'a',
            simpleName: 'a',
            filePath: 'packages/cli/src/a.ts',
            calls: [
              {
                to: ['x', 'y'],
                line: 1,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: '...',
              },
            ],
          }),
        ],
        b: [
          makeOcc({
            bodyHash: 'b',
            simpleName: 'b',
            filePath: 'packages/cli/src/b.ts',
            calls: [
              {
                to: ['x'],
                line: 1,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: '...',
              },
            ],
          }),
        ],
        x: [makeOcc({ bodyHash: 'x', simpleName: 'x', filePath: 'packages/contracts/src/x.ts' })],
        y: [makeOcc({ bodyHash: 'y', simpleName: 'y', filePath: 'packages/contracts/src/y.ts' })],
      },
      // Engine-emitted edge feature: cli→contracts has 3 call sites (a→x, a→y, b→x).
      features: { edge: [{ callerPackage: 'cli', calleePackage: 'contracts', count: 3 }] },
    };
    const env = loadEnv(catalog);
    const c = document.createElement('div');
    env.views
      .find((v) => v.id === 'coupling')!
      .render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    const cliRow = c.querySelector('td.coupling-cell[data-caller="cli"][data-callee="contracts"]');
    expect(cliRow).not.toBeNull();
    expect(cliRow!.textContent).toBe('3'); // a→x, a→y, b→x
  });

  it('wraps the table in a bounded scroll container so a large matrix stays on the page', () => {
    const catalog: GraphCatalog = {
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        a: [
          makeOcc({
            bodyHash: 'a',
            simpleName: 'a',
            filePath: 'packages/cli/src/a.ts',
            calls: [
              {
                to: ['x'],
                line: 1,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: 'x()',
              },
            ],
          }),
        ],
        x: [makeOcc({ bodyHash: 'x', simpleName: 'x', filePath: 'packages/contracts/src/x.ts' })],
      },
      features: { edge: [{ callerPackage: 'cli', calleePackage: 'contracts', count: 1 }] },
    };
    const env = loadEnv(catalog);
    const c = document.createElement('div');
    env.views
      .find((v) => v.id === 'coupling')!
      .render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    const scroll = c.querySelector('.coupling-scroll');
    expect(scroll).not.toBeNull();
    // The table must live *inside* the scroll container — that's what gives it
    // both scrollbars instead of overflowing the page.
    expect(scroll!.querySelector('table.coupling-table')).not.toBeNull();
  });

  it('opens a drilldown card listing the call sites when a cell is clicked', () => {
    const catalog: GraphCatalog = {
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        caller: [
          makeOcc({
            bodyHash: 'c1',
            simpleName: 'caller',
            filePath: 'packages/cli/src/c.ts',
            calls: [
              {
                to: ['t1'],
                line: 7,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: 'target()',
              },
            ],
          }),
        ],
        target: [
          makeOcc({
            bodyHash: 't1',
            simpleName: 'target',
            filePath: 'packages/contracts/src/t.ts',
          }),
        ],
      },
      features: { edge: [{ callerPackage: 'cli', calleePackage: 'contracts', count: 1 }] },
    };
    const env = loadEnv(catalog);
    const c = document.createElement('div');
    env.views
      .find((v) => v.id === 'coupling')!
      .render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    const cell = c.querySelector('td.coupling-cell[data-caller="cli"][data-callee="contracts"]')!;
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const overlay = document.querySelector('.function-card-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay!.textContent).toContain('cli → contracts');
    expect(overlay!.textContent).toContain('caller');
    expect(overlay!.textContent).toContain('target');
  });

  it('emits an empty cell shape when there are no calls in this direction', () => {
    const catalog: GraphCatalog = {
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        a: [
          makeOcc({
            bodyHash: 'a',
            simpleName: 'a',
            filePath: 'packages/cli/src/a.ts',
            calls: [
              {
                to: ['b'],
                line: 1,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: 'b()',
              },
            ],
          }),
        ],
        b: [makeOcc({ bodyHash: 'b', simpleName: 'b', filePath: 'packages/cli/src/b.ts' })],
      },
      // Only the cli→cli diagonal edge ⇒ a 1×1 matrix.
      features: { edge: [{ callerPackage: 'cli', calleePackage: 'cli', count: 1 }] },
    };
    const env = loadEnv(catalog);
    const c = document.createElement('div');
    env.views
      .find((v) => v.id === 'coupling')!
      .render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    // cli→contracts has no calls; the diagonal (cli→cli) does. There is no
    // 'contracts' caller, so the matrix is 1×1.
    const cells = c.querySelectorAll('td.coupling-cell');
    expect(cells.length).toBe(1);
    expect(cells[0].textContent).toBe('1');
  });

  it('renders an Export CSV button in the coupling toolbar', () => {
    const catalog: GraphCatalog = {
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        a: [
          makeOcc({
            bodyHash: 'a',
            simpleName: 'a',
            filePath: 'packages/cli/src/a.ts',
            calls: [
              {
                to: ['x'],
                line: 1,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: 'x()',
              },
            ],
          }),
        ],
        x: [makeOcc({ bodyHash: 'x', simpleName: 'x', filePath: 'packages/contracts/src/x.ts' })],
      },
      features: { edge: [{ callerPackage: 'cli', calleePackage: 'contracts', count: 3 }] },
    };
    const env = loadEnv(catalog);
    const c = document.createElement('div');
    env.views
      .find((v) => v.id === 'coupling')!
      .render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    const btn = c.querySelector('.coupling-export-btn');
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toBe('Export CSV');
  });

  it('downloads the coupling matrix as a wide, properly-escaped CSV mirroring the table', () => {
    const catalog: GraphCatalog = {
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        a: [makeOcc({ bodyHash: 'a', simpleName: 'a', filePath: 'packages/cli/src/a.ts' })],
        x: [makeOcc({ bodyHash: 'x', simpleName: 'x', filePath: 'packages/contracts/src/x.ts' })],
      },
      features: {
        edge: [
          { callerPackage: 'cli', calleePackage: 'contracts', count: 3 },
          { callerPackage: 'cli', calleePackage: 'cli', count: 2 },
          // A package name with a comma forces RFC-4180 quoting.
          { callerPackage: 'odd,pkg', calleePackage: 'cli', count: 1 },
          // A scoped package starts with '@' — a CSV/formula-injection trigger
          // that must be neutralized with a leading apostrophe.
          { callerPackage: '@scope/pkg', calleePackage: 'cli', count: 4 },
        ],
      },
    };
    const env = loadEnv(catalog);
    const c = document.createElement('div');
    env.views
      .find((v) => v.id === 'coupling')!
      .render(c, env.graphCatalog, env.graphIndexes, env.filterState);

    // Capture the Blob the download path hands to URL.createObjectURL.
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    const btn = c.querySelector<HTMLButtonElement>('.coupling-export-btn')!;
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(createSpy).toHaveBeenCalledTimes(1);
    const blob = createSpy.mock.calls[0][0] as Blob;
    createSpy.mockRestore();
    revokeSpy.mockRestore();

    return blob.text().then((text) => {
      const lines = text.split('\n');
      // Wide matrix: a corner cell + one column per callee package, sorted.
      // Package set + sort match the table: ['@scope/pkg','cli','contracts','odd,pkg'].
      expect(lines[0].startsWith('caller')).toBe(true);
      // The '@'-scoped header is apostrophe-guarded; the comma-bearing one quoted.
      expect(lines[0]).toContain('\'@scope/pkg,cli,contracts,"odd,pkg"');
      // One row per caller (every package), cells are the directed counts (0 = none).
      expect(lines).toContain("'@scope/pkg,0,4,0,0");
      expect(lines).toContain('cli,0,2,3,0');
      expect(lines).toContain('contracts,0,0,0,0');
      expect(lines).toContain('"odd,pkg",0,1,0,0');
      // 1 header + 4 caller rows (full N×N, no truncation).
      expect(lines.length).toBe(5);
    });
  });

  it('shows the no-data empty state when the catalog carries no edge feature', () => {
    const catalog: GraphCatalog = {
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        a: [
          makeOcc({
            bodyHash: 'a',
            simpleName: 'a',
            filePath: 'packages/cli/src/a.ts',
            calls: [
              {
                to: ['x'],
                line: 1,
                column: 0,
                resolution: 'static',
                confidence: 'high',
                text: 'x()',
              },
            ],
          }),
        ],
        x: [makeOcc({ bodyHash: 'x', simpleName: 'x', filePath: 'packages/contracts/src/x.ts' })],
      },
      // No features blob (a non-dashboard run) ⇒ no client recompute, no-data state.
    };
    const env = loadEnv(catalog);
    const c = document.createElement('div');
    env.views
      .find((v) => v.id === 'coupling')!
      .render(c, env.graphCatalog, env.graphIndexes, env.filterState);
    expect(c.querySelector('.empty')).not.toBeNull();
    expect(c.querySelector('td.coupling-cell')).toBeNull();
  });
});
