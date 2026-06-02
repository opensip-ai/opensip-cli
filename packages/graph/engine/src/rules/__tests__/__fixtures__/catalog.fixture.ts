/**
 * @fileoverview Shared rule-trigger fixture for the golden-fingerprint and
 * signal-output snapshot tests.
 *
 * Builds one `Catalog` whose occurrences collectively trigger all five
 * built-in rules:
 *   - `graph:orphan-subtree`         — `orphanFn` (unreachable, no callers)
 *   - `graph:test-only-reachable`    — `testHelperFn` (reached only from a test file)
 *   - `graph:no-side-effect-path`    — `pureFn` (pure, ≥2 calls, span ≥10, discarded caller)
 *   - `graph:always-throws-branch`   — `throwerFn` (every call is a `throw new …`)
 *   - `graph:duplicated-function-body` — `dupA`/`dupB`/`dupC` (same bodyHash across 3 packages)
 *
 * The shape mirrors `rule-behaviors.test.ts`'s builders. Locations are fixed
 * so the fingerprint multiset (`ruleId|file|line|col`) is deterministic.
 */

import type { Catalog, CallEdge, FunctionOccurrence } from '../../../types.js';

function occ(
  over: Partial<FunctionOccurrence> & { bodyHash: string; simpleName: string; filePath: string },
): FunctionOccurrence {
  return {
    qualifiedName: `${over.filePath}.${over.simpleName}`,
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

function edge(to: string, over: Partial<CallEdge> = {}): CallEdge {
  return { to: [to], line: 2, column: 1, resolution: 'static', confidence: 'high', text: `${to}()`, ...over };
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

/**
 * Build the all-rules trigger catalog. Each occurrence's location is fixed so
 * the emitted fingerprints are stable.
 */
export function buildAllRulesFixture(): Catalog {
  // ── orphan-subtree: a module-local function with no callers and no
  //    incoming reachability. Not exported (exported orphans are skipped),
  //    no decorators, not in a test file.
  const orphanFn = occ({
    bodyHash: 'ORPHAN',
    simpleName: 'orphanFn',
    filePath: 'packages/a/src/orphan.ts',
    line: 10,
    column: 2,
    visibility: 'module-local',
  });

  // ── test-only-reachable: a module-local production function whose only
  //    caller lives in a test file.
  const testHelperFn = occ({
    bodyHash: 'TESTHELP',
    simpleName: 'testHelperFn',
    filePath: 'packages/a/src/helper.ts',
    line: 20,
    column: 4,
    visibility: 'module-local',
  });
  const testCaller = occ({
    bodyHash: 'TESTCALLER',
    simpleName: 'testCaller',
    filePath: 'packages/a/src/helper.test.ts',
    line: 5,
    column: 0,
    inTestFile: true,
    visibility: 'module-local',
    calls: [edge('TESTHELP')],
  });

  // ── no-side-effect-path: a pure exported function (≥2 calls, span ≥10, no
  //    unresolved edges, pure callees) whose caller discards the return value.
  const pureFn = occ({
    bodyHash: 'PURE',
    simpleName: 'pureCompute',
    filePath: 'packages/a/src/pure.ts',
    line: 30,
    column: 0,
    endLine: 45,
    calls: [edge('LEAF1'), edge('LEAF2')],
  });
  const leaf1 = occ({ bodyHash: 'LEAF1', simpleName: 'leaf1', filePath: 'packages/a/src/pure.ts', line: 50, column: 0, visibility: 'module-local' });
  const leaf2 = occ({ bodyHash: 'LEAF2', simpleName: 'leaf2', filePath: 'packages/a/src/pure.ts', line: 55, column: 0, visibility: 'module-local' });
  const pureCaller = occ({
    bodyHash: 'PURECALLER',
    simpleName: 'pureDriver',
    filePath: 'packages/a/src/pure.ts',
    line: 60,
    column: 0,
    visibility: 'module-local',
    calls: [edge('PURE', { discarded: true })],
  });

  // ── always-throws-branch: every documented call site is a `throw new …`.
  const throwerFn = occ({
    bodyHash: 'THROWER',
    simpleName: 'alwaysThrows',
    filePath: 'packages/a/src/throws.ts',
    line: 70,
    column: 0,
    visibility: 'module-local',
    calls: [edge('Error', { resolution: 'unknown', confidence: 'low', text: 'throw new Error("boom")' })],
  });

  // ── duplicated-function-body: same bodyHash across THREE distinct packages
  //    (≥ default minCrossPackageDuplicatePackages = 3) → one aggregate signal.
  const dupA = occ({ bodyHash: 'DUP', simpleName: 'shared', filePath: 'packages/a/src/dup.ts', line: 80, column: 0, endLine: 90 });
  const dupB = occ({ bodyHash: 'DUP', simpleName: 'shared', filePath: 'packages/b/src/dup.ts', line: 80, column: 0, endLine: 90 });
  const dupC = occ({ bodyHash: 'DUP', simpleName: 'shared', filePath: 'packages/c/src/dup.ts', line: 80, column: 0, endLine: 90 });

  return catalogOf([
    orphanFn,
    testHelperFn,
    testCaller,
    pureFn,
    leaf1,
    leaf2,
    pureCaller,
    throwerFn,
    dupA,
    dupB,
    dupC,
  ]);
}
