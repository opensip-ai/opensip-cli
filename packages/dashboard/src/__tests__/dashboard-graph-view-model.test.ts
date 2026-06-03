/**
 * View-model projection — `projectCatalogToGraphViewModel`.
 *
 * The projector aggregates the function call graph up to PACKAGE granularity
 * (item 10): one node per package, one edge per directed package→package
 * coupling with a call-count weight. These tests lock the schema, the
 * package-attribution (mirroring `pkgOf`), the weight accounting, the
 * totalCoupling sizing input, the external-target drop, the cross-package SCC
 * pass, and the byte budget.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  GraphViewModelError,
  packageOf,
  projectCatalogToGraphViewModel,
} from '../code-paths/graph-view-model.js';

import type { GraphCatalog, GraphFunctionOccurrence } from '@opensip-tools/contracts';

const HERE = dirname(fileURLToPath(import.meta.url));

function loadFixture(): GraphCatalog {
  const candidates = [
    join(HERE, 'fixtures', 'catalog-small.json'),
    join(HERE, '..', '..', 'src', '__tests__', 'fixtures', 'catalog-small.json'),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as GraphCatalog;
    } catch {
      // try next candidate
    }
  }
  throw new Error('catalog-small.json fixture not found');
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

/** A two-package catalog: package "a" (a1→a2 internal, a1→b1 cross) and
 *  package "b" (b1→a1 cross — forms an a↔b cycle). */
function twoPackageCatalog(): GraphCatalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: 'now',
    functions: {
      a1: [
        makeOcc({
          bodyHash: 'a1',
          simpleName: 'a1',
          package: '@scope/pkg-a',
          filePath: 'packages/pkg-a/src/a1.ts',
          calls: [{ to: ['a2', 'b1'], line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'c' }],
        }),
      ],
      a2: [
        makeOcc({
          bodyHash: 'a2',
          simpleName: 'a2',
          package: '@scope/pkg-a',
          filePath: 'packages/pkg-a/src/a2.ts',
          calls: [{ to: ['ext'], line: 2, column: 0, resolution: 'static', confidence: 'high', text: 'c' }],
        }),
      ],
      b1: [
        makeOcc({
          bodyHash: 'b1',
          simpleName: 'b1',
          package: '@scope/pkg-b',
          filePath: 'packages/pkg-b/src/b1.ts',
          calls: [{ to: ['a1'], line: 3, column: 0, resolution: 'static', confidence: 'high', text: 'c' }],
        }),
      ],
    },
  };
}

describe('packageOf', () => {
  it('prefers the build-stamped package, scope-stripped', () => {
    expect(packageOf(makeOcc({ bodyHash: 'h', simpleName: 'f', package: '@opensip-tools/lang-typescript' }))).toBe(
      'lang-typescript',
    );
  });

  it('falls back to the path heuristic when package is absent', () => {
    expect(packageOf(makeOcc({ bodyHash: 'h', simpleName: 'f', filePath: 'packages/widget/src/x.ts' }))).toBe(
      'widget',
    );
  });

  it('returns <unknown> for an unattributable path', () => {
    expect(packageOf(makeOcc({ bodyHash: 'h', simpleName: 'f', filePath: 'random/x.ts' }))).toBe('<unknown>');
  });

  it('returns <unknown> when the occurrence is null/undefined or has no usable path', () => {
    expect(packageOf(null as unknown as GraphFunctionOccurrence)).toBe('<unknown>');
    expect(packageOf(undefined as unknown as GraphFunctionOccurrence)).toBe('<unknown>');
    expect(packageOf(makeOcc({ bodyHash: 'h', simpleName: 'f', filePath: '' }))).toBe('<unknown>');
  });

  it('ignores a non-string package value and a non-string path', () => {
    // package is the wrong type → fall back to the path heuristic.
    expect(
      packageOf(makeOcc({ bodyHash: 'h', simpleName: 'f', package: 42 as unknown as string, filePath: 'packages/widget/src/x.ts' })),
    ).toBe('widget');
    // path is the wrong type → <unknown>.
    expect(
      packageOf(makeOcc({ bodyHash: 'h', simpleName: 'f', filePath: 123 as unknown as string })),
    ).toBe('<unknown>');
  });
});

describe('projectCatalogToGraphViewModel (package-level)', () => {
  it('throws GraphViewModelError on a missing functions map', () => {
    expect(() => projectCatalogToGraphViewModel({} as unknown as GraphCatalog)).toThrow(GraphViewModelError);
  });

  it('projects the real fixture into a stable view-model (snapshot)', () => {
    const vm = projectCatalogToGraphViewModel(loadFixture());
    expect(vm).toMatchSnapshot();
  });

  it('carries the catalog language on the root', () => {
    const vm = projectCatalogToGraphViewModel(loadFixture());
    expect(vm.language).toBe('typescript');
  });

  it('emits PACKAGE nodes (id = label = package name) — not function nodes', () => {
    const vm = projectCatalogToGraphViewModel(twoPackageCatalog());
    const ids = vm.nodes.map(n => n.id).sort();
    expect(ids).toEqual(['pkg-a', 'pkg-b']);
    for (const node of vm.nodes) {
      expect(node.id).toBe(node.label);
      // No function-level fields leak into the package node.
      expect(node).not.toHaveProperty('kind');
      expect(node).not.toHaveProperty('filePath');
      expect(node).not.toHaveProperty('bodyHash');
      expect(typeof node.totalCoupling).toBe('number');
    }
  });

  it('emits package→package edges with a call-count weight', () => {
    const vm = projectCatalogToGraphViewModel(twoPackageCatalog());
    const byKey = new Map(vm.edges.map(e => [e.source + '->' + e.target, e]));
    // a1→a2 is an internal package-a call → self-loop weight 1.
    expect(byKey.get('pkg-a->pkg-a')?.weight).toBe(1);
    // a1→b1 cross edge, weight 1.
    expect(byKey.get('pkg-a->pkg-b')?.weight).toBe(1);
    // b1→a1 cross edge, weight 1.
    expect(byKey.get('pkg-b->pkg-a')?.weight).toBe(1);
  });

  it('aggregates multiple function calls between the same package pair into one weighted edge', () => {
    const catalog: GraphCatalog = {
      version: '3.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        a: [
          makeOcc({
            bodyHash: 'a',
            simpleName: 'a',
            package: '@s/pa',
            filePath: 'packages/pa/src/a.ts',
            calls: [{ to: ['x', 'y'], line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'c' }],
          }),
        ],
        x: [makeOcc({ bodyHash: 'x', simpleName: 'x', package: '@s/pb', filePath: 'packages/pb/src/x.ts' })],
        y: [makeOcc({ bodyHash: 'y', simpleName: 'y', package: '@s/pb', filePath: 'packages/pb/src/y.ts' })],
      },
    };
    const vm = projectCatalogToGraphViewModel(catalog);
    const edge = vm.edges.find(e => e.source === 'pa' && e.target === 'pb');
    expect(edge?.weight).toBe(2);
  });

  it('drops calls whose target is not an in-project function (external)', () => {
    const vm = projectCatalogToGraphViewModel(twoPackageCatalog());
    // a2 calls only an external 'ext' — it must NOT create any edge.
    expect(vm.edges.some(e => e.target === '<unknown>' || e.target === 'ext')).toBe(false);
  });

  it('sets totalCoupling = sum of incident edge weights (fan-in + fan-out)', () => {
    const vm = projectCatalogToGraphViewModel(twoPackageCatalog());
    for (const node of vm.nodes) {
      const incident = vm.edges
        .filter(e => e.source === node.id || e.target === node.id)
        // a self-loop contributes its weight to both fan-in and fan-out.
        .reduce((sum, e) => sum + (e.source === node.id ? e.weight : 0) + (e.target === node.id ? e.weight : 0), 0);
      expect(node.totalCoupling).toBe(incident);
    }
  });

  it('stamps a shared non-null sccId on a cross-package cycle (a↔b)', () => {
    const vm = projectCatalogToGraphViewModel(twoPackageCatalog());
    const sccIds = new Set(vm.nodes.map(n => n.sccId));
    expect(sccIds.size).toBe(1);
    expect([...sccIds][0]).not.toBeNull();
    const crossCycleEdges = vm.edges.filter(
      e => e.source !== e.target && ['pkg-a', 'pkg-b'].includes(e.source) && ['pkg-a', 'pkg-b'].includes(e.target),
    );
    for (const e of crossCycleEdges) expect(e.isCycleEdge).toBe(true);
  });

  it('does NOT flag a package as cyclic just because it has internal (self-loop) calls', () => {
    const catalog: GraphCatalog = {
      version: '3.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        a: [
          makeOcc({
            bodyHash: 'a',
            simpleName: 'a',
            package: '@s/solo',
            filePath: 'packages/solo/src/a.ts',
            calls: [{ to: ['b'], line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'c' }],
          }),
        ],
        b: [makeOcc({ bodyHash: 'b', simpleName: 'b', package: '@s/solo', filePath: 'packages/solo/src/b.ts' })],
      },
    };
    const vm = projectCatalogToGraphViewModel(catalog);
    expect(vm.nodes).toHaveLength(1);
    expect(vm.nodes[0].sccId).toBeNull();
    expect(vm.edges[0].isCycleEdge).toBe(false);
  });

  it('tolerates occurrences with no calls and edges with no targets (empty-array branches)', () => {
    const catalog: GraphCatalog = {
      version: '3.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions: {
        // No `calls` at all.
        a: [makeOcc({ bodyHash: 'a', simpleName: 'a', package: '@s/pa', filePath: 'packages/pa/src/a.ts' })],
        // A call edge with an empty `to` array.
        b: [
          makeOcc({
            bodyHash: 'b',
            simpleName: 'b',
            package: '@s/pa',
            filePath: 'packages/pa/src/b.ts',
            calls: [{ to: [], line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'c' }],
          }),
        ],
        // An empty occurrences list for a function name.
        c: [],
      },
    };
    const vm = projectCatalogToGraphViewModel(catalog);
    expect(vm.nodes.map(n => n.id)).toEqual(['pa']);
    expect(vm.edges).toHaveLength(0);
    expect(vm.nodes[0].totalCoupling).toBe(0);
    expect(vm.nodes[0].sccId).toBeNull();
  });

  it('keeps the JSON within a generous per-node/edge byte budget', () => {
    const vm = projectCatalogToGraphViewModel(loadFixture());
    const bytes = JSON.stringify(vm).length;
    // Package nodes are far slimmer than function nodes were.
    const budget = (vm.nodes.length * 120 + vm.edges.length * 80) * 1.5 + 512;
    expect(bytes).toBeLessThan(budget);
  });
});
