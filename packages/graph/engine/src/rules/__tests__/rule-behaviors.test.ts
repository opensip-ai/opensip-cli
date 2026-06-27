/**
 * Behavioral coverage for the structural rules driven through real
 * indexes (`buildIndexes`): no-side-effect-path (adapter-primitive and
 * regex-fallback detectors + discarded-caller logic), orphan-subtree
 * (entry-point reachability + config.entryPointHashes seeding), and
 * test-only-reachable.
 */

import { describe, expect, it } from 'vitest';

import { buildIndexes } from '../../pipeline/indexes.js';
import { noSideEffectPathRule } from '../no-side-effect-path.js';
import { orphanSubtreeRule } from '../orphan-subtree.js';
import { testOnlyReachableRule } from '../test-only-reachable.js';

import type { Catalog, CallEdge, FunctionOccurrence, GraphConfig, RuleHints } from '../../types.js';

function occ(
  over: Partial<FunctionOccurrence> & { bodyHash: string; simpleName: string },
): FunctionOccurrence {
  return {
    qualifiedName: `src/a.${over.simpleName}`,
    filePath: 'src/a.ts',
    line: 1,
    column: 0,
    endLine: 2,
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

function edge(to: string, over: Partial<CallEdge> = {}): CallEdge {
  return {
    to: [to],
    line: 2,
    column: 1,
    resolution: 'static',
    confidence: 'high',
    text: `${to}()`,
    ...over,
  };
}

const EMPTY_CONFIG: GraphConfig = {};

// A pure exported function (≥2 calls, span ≥10, no unresolved edges, no
// side-effecting callees) whose return value is discarded by its caller.
function pureCatalog(): Catalog {
  const pure = occ({
    bodyHash: 'PURE',
    simpleName: 'computeThing',
    endLine: 20,
    calls: [edge('LEAF1'), edge('LEAF2')],
  });
  const leaf1 = occ({
    bodyHash: 'LEAF1',
    simpleName: 'leaf1',
    visibility: 'module-local',
  });
  const leaf2 = occ({
    bodyHash: 'LEAF2',
    simpleName: 'leaf2',
    visibility: 'module-local',
  });
  const caller = occ({
    bodyHash: 'CALLER',
    simpleName: 'driver',
    visibility: 'module-local',
    calls: [edge('PURE', { discarded: true })],
  });
  return catalogOf([pure, leaf1, leaf2, caller]);
}

describe('noSideEffectPathRule', () => {
  it('flags a pure function whose caller discards its return value (regex fallback)', () => {
    const catalog = pureCatalog();
    const signals = noSideEffectPathRule.evaluate(
      catalog,
      buildIndexes(catalog),
      EMPTY_CONFIG,
      undefined,
    );
    expect(signals.map((s) => s.ruleId)).toContain('graph:no-side-effect-path');
    expect(signals[0]?.message).toContain('computeThing is pure');
  });

  it('suppresses the signal when a transitive callee has a side effect (adapter primitives)', () => {
    // LEAF1's call text contains the adapter-supplied primitive "print" →
    // LEAF1 is side-effecting → computeThing's transitive set is impure.
    const catalog = catalogOf([
      occ({
        bodyHash: 'PURE',
        simpleName: 'computeThing',
        endLine: 20,
        calls: [edge('LEAF1'), edge('LEAF2')],
      }),
      occ({
        bodyHash: 'LEAF1',
        simpleName: 'leaf1',
        visibility: 'module-local',
        calls: [edge('X', { text: 'print(x)' })],
      }),
      occ({
        bodyHash: 'LEAF2',
        simpleName: 'leaf2',
        visibility: 'module-local',
      }),
      occ({
        bodyHash: 'CALLER',
        simpleName: 'driver',
        visibility: 'module-local',
        calls: [edge('PURE', { discarded: true })],
      }),
    ]);
    const hints: RuleHints = { sideEffectPrimitives: ['print', 'os.system'] };
    const signals = noSideEffectPathRule.evaluate(
      catalog,
      buildIndexes(catalog),
      EMPTY_CONFIG,
      hints,
    );
    expect(signals).toEqual([]);
  });

  it('does not flag when no caller discards the return value', () => {
    const catalog = catalogOf([
      occ({
        bodyHash: 'PURE',
        simpleName: 'computeThing',
        endLine: 20,
        calls: [edge('LEAF1'), edge('LEAF2')],
      }),
      occ({
        bodyHash: 'LEAF1',
        simpleName: 'leaf1',
        visibility: 'module-local',
      }),
      occ({
        bodyHash: 'LEAF2',
        simpleName: 'leaf2',
        visibility: 'module-local',
      }),
      occ({
        bodyHash: 'CALLER',
        simpleName: 'driver',
        visibility: 'module-local',
        calls: [edge('PURE', { discarded: false })],
      }),
    ]);
    const signals = noSideEffectPathRule.evaluate(
      catalog,
      buildIndexes(catalog),
      EMPTY_CONFIG,
      undefined,
    );
    expect(signals).toEqual([]);
  });
});

describe('orphanSubtreeRule', () => {
  it('flags a module-local function unreachable from any entry point', () => {
    // entry (exported, uncalled) → reachable; orphan (module-local, uncalled) → orphan.
    const entry = occ({ bodyHash: 'ENTRY', simpleName: 'run', calls: [] });
    const orphan = occ({
      bodyHash: 'ORPHAN',
      simpleName: 'dead',
      visibility: 'module-local',
    });
    const catalog = catalogOf([entry, orphan]);
    const signals = orphanSubtreeRule.evaluate(
      catalog,
      buildIndexes(catalog),
      EMPTY_CONFIG,
      undefined,
    );
    const names = signals.map((s) => s.metadata?.simpleName as string | undefined);
    expect(names).toContain('dead');
    expect(names).not.toContain('run');
  });

  it('treats a config-seeded entryPointHash as reachable, suppressing its orphan signal', () => {
    const orphan = occ({
      bodyHash: 'SEEDED',
      simpleName: 'seededHelper',
      visibility: 'module-local',
    });
    const catalog = catalogOf([orphan]);
    const config: GraphConfig = { entryPointHashes: ['SEEDED'] };
    const signals = orphanSubtreeRule.evaluate(catalog, buildIndexes(catalog), config, undefined);
    expect(signals.map((s) => s.metadata?.simpleName)).not.toContain('seededHelper');
  });
});

describe('testOnlyReachableRule', () => {
  it('flags a module-local function whose only caller is a test file', () => {
    // A production entry that reaches `prodReached` keeps it off the list;
    // `testFixture` is module-local and reached only from a test-file caller.
    const entry = occ({
      bodyHash: 'ENTRY',
      simpleName: 'run',
      calls: [edge('PRODREACHED')],
    });
    const prodReached = occ({
      bodyHash: 'PRODREACHED',
      simpleName: 'prodReached',
      visibility: 'module-local',
    });
    const testFixture = occ({
      bodyHash: 'FIXTURE',
      simpleName: 'testFixture',
      visibility: 'module-local',
    });
    const testCaller = occ({
      bodyHash: 'TEST',
      simpleName: 'spec',
      filePath: 'src/a.test.ts',
      inTestFile: true,
      visibility: 'module-local',
      calls: [edge('FIXTURE')],
    });
    const catalog = catalogOf([entry, prodReached, testFixture, testCaller]);
    const signals = testOnlyReachableRule.evaluate(
      catalog,
      buildIndexes(catalog),
      EMPTY_CONFIG,
      undefined,
    );
    const names = signals.map((s) => s.metadata?.qualifiedName as string | undefined);
    expect(names).toContain('src/a.testFixture');
  });

  it('does not flag an exported function reachable only from tests (intentional API)', () => {
    const testCaller = occ({
      bodyHash: 'TEST',
      simpleName: 'spec',
      filePath: 'src/a.test.ts',
      inTestFile: true,
      visibility: 'module-local',
      calls: [edge('API')],
    });
    const exportedApi = occ({
      bodyHash: 'API',
      simpleName: 'publicApi',
      visibility: 'exported',
    });
    const catalog = catalogOf([exportedApi, testCaller]);
    const signals = testOnlyReachableRule.evaluate(
      catalog,
      buildIndexes(catalog),
      EMPTY_CONFIG,
      undefined,
    );
    expect(signals.map((s) => s.metadata?.qualifiedName)).not.toContain('src/a.publicApi');
  });
});
