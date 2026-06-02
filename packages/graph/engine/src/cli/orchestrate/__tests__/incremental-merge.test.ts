/**
 * Wave-4 incremental helpers: closure-expansion fixpoint, occurrence
 * merging, and edge stitching. These drive the incremental rebuild path
 * in catalog-builder. The tests exercise them directly with plain
 * catalog data + a minimal walk-only adapter stub.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ownerEdgeKey } from '../../../owner-key.js';
import {
  expandClosureToFixpoint,
  mergeOccurrences,
  mergeResolvedAndCachedEdges,
} from '../incremental-merge.js';

import type {
  GraphLanguageAdapter,
  ParsedProject,
  WalkOutput,
} from '../../../lang-adapter/types.js';
import type { Catalog, CallEdge, FunctionOccurrence } from '../../../types.js';

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

describe('mergeOccurrences', () => {
  it('takes walked entries for closure files and cached entries for the rest', () => {
    const cached = catalogOf(occ('a', 'a.ts', 'A1'), occ('b', 'b.ts', 'B1'));
    // a.ts changed → freshly-walked occurrence with a new hash.
    const walked = { a: [occ('a', 'a.ts', 'A2')] };
    const merged = mergeOccurrences(cached, walked, new Set(['a.ts']));
    // a.ts is in the closure → walked A2 wins; b.ts unchanged → cached B1 kept.
    expect(merged.a?.map((o) => o.bodyHash)).toEqual(['A2']);
    expect(merged.b?.map((o) => o.bodyHash)).toEqual(['B1']);
  });
});

describe('mergeResolvedAndCachedEdges', () => {
  it('applies freshly-resolved edges to closure files and restores cached edges elsewhere', () => {
    const cachedEdge: CallEdge = {
      to: ['B1'], line: 2, column: 1, resolution: 'static', confidence: 'high', text: 'b()',
    };
    const freshEdge: CallEdge = {
      to: ['B1'], line: 3, column: 1, resolution: 'static', confidence: 'high', text: 'b()',
    };
    const cached = catalogOf(occ('a', 'a.ts', 'A1', [cachedEdge]), occ('b', 'b.ts', 'B1'));
    // Merged catalog: a.ts (closure, hash A1) + unchanged b.ts (B1).
    const merged = catalogOf(occ('a', 'a.ts', 'A1'), occ('b', 'b.ts', 'B1'));
    const edgesByOwner = new Map<string, readonly CallEdge[]>([
      [ownerEdgeKey('A1', 'a.ts'), [freshEdge]],
    ]);

    const out = mergeResolvedAndCachedEdges(merged, cached, edgesByOwner, new Set(['a.ts']));
    // a.ts in closure → fresh edge (line 3); b.ts unchanged → cached calls ([] here).
    expect(out.a?.[0]?.calls).toEqual([freshEdge]);
    expect(out.b?.[0]?.calls).toEqual([]);
  });

  it('falls back to an empty calls array for a closure owner with no resolved edges', () => {
    const merged = catalogOf(occ('a', 'a.ts', 'A1'));
    const cached = catalogOf(occ('a', 'a.ts', 'A1'));
    const out = mergeResolvedAndCachedEdges(merged, cached, new Map(), new Set(['a.ts']));
    expect(out.a?.[0]?.calls).toEqual([]);
  });
});

// A walk-only adapter stub: returns occurrences for whatever files it's
// handed. The stale-hash scan compares these against the cached catalog.
function walkAdapter(byFile: Record<string, FunctionOccurrence[]>): GraphLanguageAdapter {
  return {
    walkProject: ({ files }: { files: readonly string[] }): WalkOutput => {
      const occurrences: Record<string, FunctionOccurrence[]> = {};
      for (const abs of files) {
        const rel = abs.split('/').at(-1) ?? abs;
        for (const o of byFile[rel] ?? []) {
          const bucket = occurrences[o.simpleName];
          if (bucket) bucket.push(o);
          else occurrences[o.simpleName] = [o];
        }
      }
      return { occurrences, callSites: [], parseErrors: [] };
    },
  } as unknown as GraphLanguageAdapter;
}

// ParsedProject is `unknown` — a plain token object satisfies it directly.
const PROJECT: ParsedProject = { token: 'p' };

describe('expandClosureToFixpoint', () => {
  it('reaches a fixpoint in one pass when no cached hash went stale', () => {
    const root = '/repo';
    const changed = join(root, 'a.ts');
    // Changed file re-walks to the SAME hash → nothing went stale.
    const cached = catalogOf(occ('a', 'a.ts', 'A1'), occ('b', 'b.ts', 'B1'));
    const adapter = walkAdapter({ 'a.ts': [occ('a', 'a.ts', 'A1')] });

    const { walked, closureRel } = expandClosureToFixpoint({
      adapter,
      discovery: { projectDirAbs: root, files: [changed, join(root, 'b.ts')] },
      cachedCatalog: cached,
      parsedProject: PROJECT,
      changedFilesAbs: [changed],
    });
    expect([...closureRel]).toEqual(['a.ts']);
    expect(walked.occurrences.a?.[0]?.bodyHash).toBe('A1');
  });

  it('does not grow the closure when the stale hash has no cached dependents', () => {
    const root = '/repo';
    const changed = join(root, 'a.ts');
    // a.ts's cached hash A1 vanishes (re-walks to A2), but no cached edge
    // anywhere points at A1 → no dependents → fixpoint after one pass.
    const cached = catalogOf(occ('a', 'a.ts', 'A1'), occ('b', 'b.ts', 'B1'));
    const adapter = walkAdapter({ 'a.ts': [occ('a', 'a.ts', 'A2')] });

    const { closureRel } = expandClosureToFixpoint({
      adapter,
      discovery: { projectDirAbs: root, files: [changed, join(root, 'b.ts')] },
      cachedCatalog: cached,
      parsedProject: PROJECT,
      changedFilesAbs: [changed],
    });
    expect([...closureRel]).toEqual(['a.ts']);
  });
});
