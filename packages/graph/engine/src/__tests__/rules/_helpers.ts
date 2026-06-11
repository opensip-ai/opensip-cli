/**
 * Shared catalog/occurrence factories for the rule unit tests.
 *
 * These tests synthesize tiny catalogs without going through the
 * full discover→inventory→edges pipeline. The helpers here produce
 * well-typed FunctionOccurrence/CallEdge/Catalog values so the
 * tests stay focused on the rule under test.
 */

import type { CallEdge, Catalog, FunctionOccurrence } from '../../types.js';

export interface OccOverride extends Partial<FunctionOccurrence> {
  readonly bodyHash: string;
  readonly simpleName: string;
}

export function occ(over: OccOverride): FunctionOccurrence {
  const base: FunctionOccurrence = {
    bodyHash: over.bodyHash,
    bodySize: 200,
    simpleName: over.simpleName,
    qualifiedName: over.qualifiedName ?? `src/a.${over.simpleName}`,
    filePath: 'src/a.ts',
    line: 1,
    column: 0,
    endLine: 5,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'module-local',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
  };
  return { ...base, ...over };
}

export function edge(text: string, to: readonly string[] = [], discarded?: boolean): CallEdge {
  return {
    to,
    line: 2,
    column: 4,
    resolution: 'unknown',
    confidence: 'low',
    text,
    discarded,
  };
}

export function staticCall(to: string, discarded?: boolean): CallEdge {
  return {
    to: [to],
    line: 1,
    column: 0,
    resolution: 'static',
    confidence: 'high',
    text: 'fn()',
    discarded,
  };
}

export function makeCatalog(occs: readonly FunctionOccurrence[]): Catalog {
  const functions: Record<string, FunctionOccurrence[]> = {};
  for (const o of occs) {
    let bucket = functions[o.simpleName];
    if (!bucket) {
      bucket = [];
      functions[o.simpleName] = bucket;
    }
    bucket.push(o);
  }
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: 'x',
    cacheKey: 'ts-test-v3',
    functions,
  };
}
