/**
 * Focused coverage for `graph:cycle`'s `metadata.memberLocations` (ADR-0014):
 * the per-SCC signal must carry every resolvable member's `{ file, line }` so
 * graph's suppression `locate()` can waive the one-per-SCC finding via a
 * `@graph-ignore` directive above ANY member — not only the computed anchor.
 *
 * Drives the rule's `evaluate` directly with a synthetic `scc` feature, mirroring
 * the `catalogOf` / `buildIndexes` harness in `__tests__/rule-behaviors.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { buildIndexes } from '../pipeline/indexes.js';

import { cycleRule } from './cycle.js';

import type {
  Catalog,
  FeatureTable,
  FunctionOccurrence,
  GraphConfig,
  SccFeatures,
} from '../types.js';

function occ(
  over: Partial<FunctionOccurrence> & {
    bodyHash: string;
    simpleName: string;
    filePath: string;
    line: number;
  },
): FunctionOccurrence {
  return {
    qualifiedName: `${over.filePath}.${over.simpleName}`,
    column: 0,
    endLine: over.line + 1,
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

function catalogOf(occs: readonly FunctionOccurrence[]): Catalog {
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

function featuresWith(scc: SccFeatures): FeatureTable {
  return {
    function: new Map(),
    package: new Map(),
    scc: [scc],
    edge: [],
  };
}

const EMPTY_CONFIG: GraphConfig = {};

describe('cycleRule memberLocations', () => {
  it('attaches a non-empty memberLocations array covering the SCC members', () => {
    // A 3-member intra-package cycle (size ≥ default cycleMinSize → medium band).
    const a = occ({
      bodyHash: 'A',
      simpleName: 'a',
      filePath: 'src/a.ts',
      line: 3,
    });
    const b = occ({
      bodyHash: 'B',
      simpleName: 'b',
      filePath: 'src/b.ts',
      line: 7,
    });
    const c = occ({
      bodyHash: 'C',
      simpleName: 'c',
      filePath: 'src/c.ts',
      line: 11,
    });
    const catalog = catalogOf([a, b, c]);
    // Members are occIds (`${filePath}:${line}:${column}`), resolved via byOccId.
    const scc: SccFeatures = {
      id: 'scc:src/a.ts:3:0',
      members: ['src/a.ts:3:0', 'src/b.ts:7:0', 'src/c.ts:11:0'],
      sccSize: 3,
      crossesPackages: false,
    };

    const signals = cycleRule.evaluate(
      catalog,
      buildIndexes(catalog),
      EMPTY_CONFIG,
      undefined,
      featuresWith(scc),
    );

    expect(signals).toHaveLength(1);
    const members = signals[0]?.metadata.memberLocations;
    expect(Array.isArray(members)).toBe(true);
    expect(members).toEqual(
      expect.arrayContaining([
        { file: 'src/a.ts', line: 3 },
        { file: 'src/b.ts', line: 7 },
        { file: 'src/c.ts', line: 11 },
      ]),
    );
    expect((members as readonly unknown[]).length).toBe(3);
  });
});
