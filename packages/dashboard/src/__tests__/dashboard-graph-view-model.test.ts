/**
 * View-model projection — `projectCatalogToGraphViewModel`.
 *
 * The projector is the bundle-size budget enforcement point; these tests
 * lock the schema (field presence), the degree-accounting invariants, the
 * SCC pass, the external-target drop, the byte budget, and the
 * performance pre-filter (top-N truncation).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MAX_INLINE_NODES,
  GraphViewModelError,
  projectCatalogToGraphViewModel,
} from '../code-paths/graph-view-model.js';

import type { GraphCatalog, GraphFunctionOccurrence } from '@opensip-tools/contracts';

const HERE = dirname(fileURLToPath(import.meta.url));

function loadFixture(): GraphCatalog {
  // The fixture lives next to the compiled test; resolve relative to source
  // (dist mirrors the layout, so `__tests__/fixtures/` resolves in both).
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

describe('projectCatalogToGraphViewModel', () => {
  it('throws GraphViewModelError on a missing functions map', () => {
    expect(() => projectCatalogToGraphViewModel({} as unknown as GraphCatalog)).toThrow(
      GraphViewModelError,
    );
  });

  it('projects the fixture into a stable view-model (snapshot)', () => {
    const vm = projectCatalogToGraphViewModel(loadFixture());
    expect(vm).toMatchSnapshot();
  });

  it('carries the catalog language on the root', () => {
    const vm = projectCatalogToGraphViewModel(loadFixture());
    expect(vm.language).toBe('typescript');
  });

  it('emits one node per occurrence and every schema field', () => {
    const vm = projectCatalogToGraphViewModel(loadFixture());
    expect(vm.nodes.length).toBe(20);
    for (const node of vm.nodes) {
      expect(typeof node.id).toBe('string');
      expect(typeof node.label).toBe('string');
      expect(typeof node.filePath).toBe('string');
      expect(typeof node.kind).toBe('string');
      expect(typeof node.visibility).toBe('string');
      expect(typeof node.inTestFile).toBe('boolean');
      expect(typeof node.callDegreeIn).toBe('number');
      expect(typeof node.callDegreeOut).toBe('number');
      expect(node.sccId === null || typeof node.sccId === 'string').toBe(true);
    }
    for (const edge of vm.edges) {
      expect(typeof edge.source).toBe('string');
      expect(typeof edge.target).toBe('string');
      expect(typeof edge.resolution).toBe('string');
      expect(typeof edge.confidence).toBe('string');
      expect(typeof edge.isCycleEdge).toBe('boolean');
    }
  });

  it('drops edges whose target is not an in-project node', () => {
    const vm = projectCatalogToGraphViewModel(loadFixture());
    const ids = new Set(vm.nodes.map(n => n.id));
    for (const edge of vm.edges) {
      expect(ids.has(edge.source)).toBe(true);
      expect(ids.has(edge.target)).toBe(true);
    }
    // The external target `hZZ_external` must never appear.
    expect(vm.edges.some(e => e.target === 'hZZ_external')).toBe(false);
  });

  it('callDegreeIn/Out equal the incident edge counts', () => {
    const vm = projectCatalogToGraphViewModel(loadFixture());
    for (const node of vm.nodes) {
      const inCount = vm.edges.filter(e => e.target === node.id).length;
      const outCount = vm.edges.filter(e => e.source === node.id).length;
      expect(node.callDegreeIn).toBe(inCount);
      expect(node.callDegreeOut).toBe(outCount);
    }
  });

  it('stamps a shared non-null sccId on the known 3-cycle', () => {
    const vm = projectCatalogToGraphViewModel(loadFixture());
    const cyclic = vm.nodes.filter(n => ['h05', 'h06', 'h07'].includes(n.id));
    expect(cyclic).toHaveLength(3);
    const sccIds = new Set(cyclic.map(n => n.sccId));
    expect(sccIds.size).toBe(1);
    expect([...sccIds][0]).not.toBeNull();
    // Edges entirely within the cycle are flagged.
    const cycleEdges = vm.edges.filter(
      e => ['h05', 'h06', 'h07'].includes(e.source) && ['h05', 'h06', 'h07'].includes(e.target),
    );
    expect(cycleEdges.length).toBeGreaterThanOrEqual(3);
    for (const e of cycleEdges) expect(e.isCycleEdge).toBe(true);
  });

  it('leaves acyclic nodes with sccId null and isCycleEdge false', () => {
    const vm = projectCatalogToGraphViewModel(loadFixture());
    const h00 = vm.nodes.find(n => n.id === 'h00');
    expect(h00?.sccId).toBeNull();
    // The hub edges into h00 are not cycle edges.
    const intoHub = vm.edges.filter(e => e.target === 'h00');
    for (const e of intoHub) expect(e.isCycleEdge).toBe(false);
  });

  it('omits truncatedFromTotal when below the cap', () => {
    const vm = projectCatalogToGraphViewModel(loadFixture());
    expect(vm.truncatedFromTotal).toBeUndefined();
  });

  it('keeps the JSON within the per-node/edge byte budget', () => {
    const vm = projectCatalogToGraphViewModel(loadFixture());
    const bytes = JSON.stringify(vm).length;
    // Phase 0 §4.5: ~246 B/node + ~104 B/edge. Generous 1.5x margin for a
    // tiny fixture (fixed JSON overhead dominates at this scale).
    const budget = Math.round((vm.nodes.length * 246 + vm.edges.length * 104) * 1.5) + 512;
    expect(bytes).toBeLessThan(budget);
  });

  it('exposes the documented default cap', () => {
    expect(DEFAULT_MAX_INLINE_NODES).toBe(5000);
  });

  it('truncates to the top-N by call degree and records the pre-truncation total', () => {
    // Build a 6-node catalog where degrees are strictly ordered, cap at 3.
    const functions: Record<string, GraphFunctionOccurrence[]> = {};
    for (let i = 0; i < 6; i++) {
      const id = `n${i}`;
      // n0 calls everyone (high out-degree); everyone calls n5 (high in-degree).
      const targets = i === 0 ? ['n1', 'n2', 'n3', 'n4', 'n5'] : ['n5'];
      functions[`fn${i}`] = [
        makeOcc({
          bodyHash: id,
          simpleName: `fn${i}`,
          calls: [
            {
              to: targets.filter(t => t !== id),
              line: 1,
              column: 0,
              resolution: 'static',
              confidence: 'high',
              text: 'c',
            },
          ],
        }),
      ];
    }
    const catalog: GraphCatalog = {
      version: '3.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'now',
      functions,
    };
    const vm = projectCatalogToGraphViewModel(catalog, { maxInlineNodes: 3 });
    expect(vm.nodes.length).toBe(3);
    expect(vm.truncatedFromTotal).toBe(6);
    // Every retained edge has both endpoints in the kept set.
    const kept = new Set(vm.nodes.map(n => n.id));
    for (const e of vm.edges) {
      expect(kept.has(e.source)).toBe(true);
      expect(kept.has(e.target)).toBe(true);
    }
    // n0 (out-degree 5) and n5 (in-degree 5) are the most central — kept.
    expect(kept.has('n0')).toBe(true);
    expect(kept.has('n5')).toBe(true);
  });
});
