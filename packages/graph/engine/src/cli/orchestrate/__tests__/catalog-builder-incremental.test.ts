/**
 * `buildAndResolveCatalogIncremental` — the Wave-4 incremental rebuild
 * path. Drives it with a complete walk/parse/resolve adapter stub over a
 * two-file project where one file changed, asserting that the closure
 * file gets freshly-resolved edges while the unchanged file keeps its
 * cached edges and the dependency post-pass attaches module-level deps.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildAndResolveCatalogIncremental } from '../catalog-builder.js';

import type {
  GraphLanguageAdapter,
  ParseOutput,
  ResolveOutput,
  WalkOutput,
} from '../../../lang-adapter/types.js';
import type {
  Catalog,
  CallEdge,
  DependencyEdge,
  FunctionOccurrence,
} from '../../../types.js';
import type { RunStage } from '../catalog-builder.js';

// A pass-through runStage: just invoke the work fn. The orchestrator's
// real one adds progress/pressure plumbing we don't need here.
const runStage: RunStage = (_stage, _onProgress, _monitor, fn) => fn();

function occ(
  simpleName: string,
  filePath: string,
  bodyHash: string,
  calls: readonly CallEdge[] = [],
): FunctionOccurrence {
  return {
    bodyHash,
    simpleName,
    qualifiedName: `${filePath}.${simpleName}`,
    filePath,
    line: 1,
    column: 0,
    endLine: 1,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'exported',
    inTestFile: false,
    definedInGenerated: false,
    calls,
  };
}

function catalogOf(...occs: FunctionOccurrence[]): Catalog {
  const functions: Record<string, FunctionOccurrence[]> = {};
  for (const o of occs) {
    const bucket = functions[o.simpleName];
    if (bucket) bucket.push(o);
    else functions[o.simpleName] = [o];
  }
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: 'x',
    cacheKey: 'k',
    resolutionMode: 'exact',
    functions,
  };
}

const ROOT = '/repo';

function incrementalAdapter(opts: {
  walked: Record<string, FunctionOccurrence[]>;
  edges: ReadonlyMap<string, readonly CallEdge[]>;
  deps?: ReadonlyMap<string, readonly DependencyEdge[]>;
}): GraphLanguageAdapter {
  return {
    id: 'typescript',
    displayName: 'Fake',
    parseProject: (): ParseOutput => ({ project: { token: 'p' }, parseErrors: [] }),
    walkProject: ({ files }: { files: readonly string[] }): WalkOutput => {
      const occurrences: Record<string, FunctionOccurrence[]> = {};
      for (const abs of files) {
        const rel = abs.split('/').at(-1) ?? abs;
        for (const o of opts.walked[rel] ?? []) {
          const bucket = occurrences[o.simpleName];
          if (bucket) bucket.push(o);
          else occurrences[o.simpleName] = [o];
        }
      }
      return { occurrences, callSites: [], parseErrors: [] };
    },
    resolveCallSites: (): ResolveOutput => ({
      edgesByOwner: opts.edges,
      dependenciesByOwner: opts.deps,
      stats: { totalCallSites: 1, resolvedHigh: 1, resolvedMedium: 0, resolvedLow: 0, unresolved: 0 },
    }),
    cacheKey: () => 'fake-v1',
  } as unknown as GraphLanguageAdapter;
}

describe('buildAndResolveCatalogIncremental', () => {
  const root = ROOT;

  it('re-resolves closure files and keeps cached edges for unchanged files', () => {
    const cachedEdge: CallEdge = {
      to: ['B1'], line: 5, column: 1, resolution: 'static', confidence: 'high', text: 'b()',
    };
    const cached = catalogOf(occ('a', 'a.ts', 'A1'), occ('b', 'b.ts', 'B1', [cachedEdge]));

    // a.ts changed → re-walks to A2 with a fresh edge into B1.
    const freshEdge: CallEdge = {
      to: ['B1'], line: 7, column: 1, resolution: 'static', confidence: 'high', text: 'b()',
    };
    const adapter = incrementalAdapter({
      walked: { 'a.ts': [occ('a', 'a.ts', 'A2')] },
      edges: new Map([['A2', [freshEdge]]]),
    });

    const { catalog, resolutionStats } = buildAndResolveCatalogIncremental(
      runStage,
      adapter,
      { projectDirAbs: root, files: [join(root, 'a.ts'), join(root, 'b.ts')] },
      cached,
      [join(root, 'a.ts')],
      'exact',
    );

    // a re-walked to A2 with the fresh edge; b unchanged keeps its cached edge.
    expect(catalog.functions.a?.[0]?.bodyHash).toBe('A2');
    expect(catalog.functions.a?.[0]?.calls).toEqual([freshEdge]);
    expect(catalog.functions.b?.[0]?.calls).toEqual([cachedEdge]);
    expect(resolutionStats.totalCallSites).toBe(1);
  });

  it('attaches module-level dependency edges via the incremental post-pass', () => {
    const cached = catalogOf(occ('mod', 'a.ts', 'M1'));
    const dep: DependencyEdge = { to: ['lodash'], specifier: 'lodash', line: 1, column: 0 };
    const adapter = incrementalAdapter({
      walked: { 'a.ts': [occ('mod', 'a.ts', 'M1')] },
      edges: new Map(),
      deps: new Map([['M1', [dep]]]),
    });

    const { catalog } = buildAndResolveCatalogIncremental(
      runStage,
      adapter,
      { projectDirAbs: root, files: [join(root, 'a.ts')] },
      cached,
      [join(root, 'a.ts')],
      'exact',
    );
    expect(catalog.functions.mod?.[0]?.dependencies).toEqual([dep]);
  });
});
