import { describe, expect, it } from 'vitest';

import { evaluateOrphanSubtree } from '../analysis/rules/orphan-subtree.js';
import { makeFunctionId } from '../catalog/ids.js';
import { buildIndexes } from '../catalog/index-builder.js';
import { CATALOG_LANGUAGE, CATALOG_TOOL, CATALOG_VERSION, type Catalog, type CallSite, type FunctionNode } from '../catalog/types.js';

interface FixtureFn {
  name: string;
  filePath?: string;
  inTestFile?: boolean;
  visibility?: 'exported' | 'module-local' | 'private';
  calls?: readonly { target: string; resolution?: 'static' | 'method-dispatch' }[];
}

function makeFn(spec: FixtureFn): FunctionNode {
  const filePath = spec.filePath ?? 'src/main.ts';
  const id = makeFunctionId({ contentHash: spec.name, filePath, simpleName: spec.name });
  const calls: CallSite[] = (spec.calls ?? []).map((c, i) => ({
    line: i + 2,
    column: 4,
    resolvedTo: [makeFunctionId({ contentHash: c.target, filePath: 'src/main.ts', simpleName: c.target })],
    resolution: c.resolution ?? 'static',
    confidence: 'high',
    text: `${c.target}()`,
  }));
  return {
    id,
    qualifiedName: `${filePath}.${spec.name}`,
    simpleName: spec.name,
    filePath,
    line: 1,
    column: 1,
    endLine: 5,
    kind: 'function',
    params: [],
    visibility: spec.visibility ?? 'module-local',
    decorators: [],
    directSideEffects: null,
    inTestFile: spec.inTestFile ?? false,
    definedInGenerated: false,
    calls,
  };
}

function makeCatalog(specs: readonly FixtureFn[]): Catalog {
  const fns = specs.map((s) => makeFn(s));
  return {
    version: CATALOG_VERSION,
    tool: CATALOG_TOOL,
    language: CATALOG_LANGUAGE,
    builtAt: '2026-05-15T00:00:00Z',
    tsConfigPath: '/example/tsconfig.json',
    tsCompilerVersion: '5.7.2',
    files: [],
    functions: fns,
    indexes: buildIndexes(fns),
  };
}

describe('graph:orphan-subtree', () => {
  it('does not fire when every function has a caller', () => {
    const catalog = makeCatalog([
      { name: 'main', calls: [{ target: 'helper' }] },
      { name: 'helper' },
    ]);
    expect(evaluateOrphanSubtree(catalog)).toEqual([]);
  });

  it('fires on a function that nobody calls', () => {
    // `main` is on the entry-point name allowlist so it's skipped as a
    // candidate root — only `unused` triggers the rule.
    const catalog = makeCatalog([
      { name: 'main', calls: [{ target: 'helper' }] },
      { name: 'helper' },
      { name: 'unused' },
    ]);
    const findings = evaluateOrphanSubtree(catalog);
    expect(findings).toHaveLength(1);
    const orphans = findings.flatMap((f) => (f.metadata as { subtreeFunctions: string[] }).subtreeFunctions);
    expect(orphans).toContain('src/main.ts.unused');
  });

  it('rolls private callees into the orphan subtree', () => {
    const catalog = makeCatalog([
      { name: 'orphan', calls: [{ target: 'privateHelper' }] },
      { name: 'privateHelper' },
    ]);
    const findings = evaluateOrphanSubtree(catalog);
    expect(findings).toHaveLength(1);
    const meta = findings[0].metadata as { subtreeSize: number; subtreeFunctions: readonly string[] };
    expect(meta.subtreeSize).toBe(2);
    expect(meta.subtreeFunctions).toEqual(expect.arrayContaining(['src/main.ts.orphan', 'src/main.ts.privateHelper']));
  });

  it('does NOT include a callee that has a caller outside the orphan subtree', () => {
    // shared has two callers — one is the orphan, one is reachable. So shared
    // is not solely owned by the orphan; it must not be folded into the
    // orphan's subtree.
    const catalog = makeCatalog([
      { name: 'main', calls: [{ target: 'shared' }] },
      { name: 'orphan', calls: [{ target: 'shared' }] },
      { name: 'shared' },
    ]);
    const findings = evaluateOrphanSubtree(catalog);
    // `main` is on the entry-point allowlist; only `orphan` is a candidate root.
    const orphanFinding = findings.find((f) => {
      const m = f.metadata as { subtreeFunctions: readonly string[] };
      return m.subtreeFunctions.includes('src/main.ts.orphan');
    });
    expect(orphanFinding).toBeDefined();
    const m = orphanFinding!.metadata as { subtreeFunctions: readonly string[] };
    expect(m.subtreeFunctions).not.toContain('src/main.ts.shared');
  });

  it('skips functions in test files', () => {
    const catalog = makeCatalog([
      { name: 'testHelper', filePath: 'src/__tests__/x.test.ts', inTestFile: true },
    ]);
    expect(evaluateOrphanSubtree(catalog)).toEqual([]);
  });

  it('skips conventional entry-point names like main and handler', () => {
    const catalog = makeCatalog([
      { name: 'main' },
      { name: 'handler' },
    ]);
    expect(evaluateOrphanSubtree(catalog)).toEqual([]);
  });

  it('reports medium confidence when polymorphic dispatch is involved in the subtree', () => {
    const catalog = makeCatalog([
      { name: 'orphan', calls: [{ target: 'iface', resolution: 'method-dispatch' }] },
      { name: 'iface' },
    ]);
    const findings = evaluateOrphanSubtree(catalog);
    expect(findings).toHaveLength(1);
    const m = findings[0].metadata as { confidence: string };
    expect(m.confidence).toBe('medium');
  });

  it('reports high confidence on a polymorphism-free subtree', () => {
    const catalog = makeCatalog([
      { name: 'orphan', calls: [{ target: 'helper' }] },
      { name: 'helper' },
    ]);
    const findings = evaluateOrphanSubtree(catalog);
    expect(findings).toHaveLength(1);
    const m = findings[0].metadata as { confidence: string };
    expect(m.confidence).toBe('high');
  });
});
