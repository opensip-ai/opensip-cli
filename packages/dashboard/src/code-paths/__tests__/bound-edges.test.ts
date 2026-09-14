import { describe, expect, it } from 'vitest';

import { boundEdgeFeature, resolvableCouplingPairs } from '../bound-edges.js';

function occ(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bodyHash: 'h1',
    qualifiedName: 'pkg-a/mod#fn',
    package: 'pkg-a',
    calls: [],
    ...overrides,
  };
}

describe('packageIdentityOf (via resolvableCouplingPairs)', () => {
  it('falls back to the packages/<name>/ filePath heuristic when package is absent', () => {
    const caller = occ({
      bodyHash: 'caller',
      package: undefined,
      filePath: 'packages/pkg-b/src/index.ts',
      calls: [{ to: ['callee'] }],
    });
    const callee = occ({ bodyHash: 'callee', package: 'pkg-c' });
    const pairs = resolvableCouplingPairs({ a: [caller, callee] });
    expect(pairs.has('pkg-b pkg-c')).toBe(true);
  });

  it('falls back to <unknown> when neither package nor a matching filePath is present', () => {
    const caller = occ({
      bodyHash: 'caller',
      package: undefined,
      filePath: undefined,
      calls: [{ to: ['callee'] }],
    });
    const callee = occ({ bodyHash: 'callee', package: 'pkg-c' });
    const pairs = resolvableCouplingPairs({ a: [caller, callee] });
    expect(pairs.has('<unknown> pkg-c')).toBe(true);
  });

  it('falls back to <unknown> when filePath does not match the packages/<name>/ shape', () => {
    const caller = occ({
      bodyHash: 'caller',
      package: undefined,
      filePath: 'scripts/build.mjs',
      calls: [{ to: ['callee'] }],
    });
    const callee = occ({ bodyHash: 'callee', package: 'pkg-c' });
    const pairs = resolvableCouplingPairs({ a: [caller, callee] });
    expect(pairs.has('<unknown> pkg-c')).toBe(true);
  });
});

describe('resolveCallee (via resolvableCouplingPairs)', () => {
  it('prefers a same-package twin over an out-of-package candidate for the same body hash', () => {
    const caller = occ({ bodyHash: 'caller', package: 'pkg-a', calls: [{ to: ['shared'] }] });
    const twinInCallerPackage = occ({
      bodyHash: 'shared',
      package: 'pkg-a',
      qualifiedName: 'pkg-a/mod#z',
    });
    const twinElsewhere = occ({
      bodyHash: 'shared',
      package: 'pkg-b',
      qualifiedName: 'pkg-b/mod#a',
    });
    const pairs = resolvableCouplingPairs({ a: [caller, twinInCallerPackage, twinElsewhere] });
    // Same-package twin wins even though it does not sort first alphabetically.
    expect(pairs.has('pkg-a pkg-a')).toBe(true);
    expect(pairs.has('pkg-a pkg-b')).toBe(false);
  });

  it('falls back to the lexicographically-lowest qualified name when no candidate shares the caller package', () => {
    const caller = occ({ bodyHash: 'caller', package: 'pkg-a', calls: [{ to: ['shared'] }] });
    const higher = occ({
      bodyHash: 'shared',
      package: 'pkg-c',
      qualifiedName: 'pkg-c/mod#zzz',
    });
    const lower = occ({
      bodyHash: 'shared',
      package: 'pkg-b',
      qualifiedName: 'pkg-b/mod#aaa',
    });
    const pairs = resolvableCouplingPairs({ a: [caller, higher, lower] });
    expect(pairs.has('pkg-a pkg-b')).toBe(true);
    expect(pairs.has('pkg-a pkg-c')).toBe(false);
  });

  it('resolves a single-candidate body hash directly, without disambiguation', () => {
    const caller = occ({ bodyHash: 'caller', package: 'pkg-a', calls: [{ to: ['shared'] }] });
    const onlyCandidate = occ({ bodyHash: 'shared', package: 'pkg-b' });
    const pairs = resolvableCouplingPairs({ a: [caller, onlyCandidate] });
    expect(pairs.has('pkg-a pkg-b')).toBe(true);
  });

  it('ignores a call target with no matching body hash in the retained set', () => {
    const caller = occ({ bodyHash: 'caller', package: 'pkg-a', calls: [{ to: ['missing'] }] });
    const pairs = resolvableCouplingPairs({ a: [caller] });
    expect(pairs.size).toBe(0);
  });
});

describe('callTargetsOf (via resolvableCouplingPairs)', () => {
  it('ignores non-array calls, malformed edges, and non-array `to` fields', () => {
    const malformed = occ({ bodyHash: 'caller', package: 'pkg-a', calls: 'not-an-array' });
    expect(resolvableCouplingPairs({ a: [malformed] }).size).toBe(0);

    const malformedEdge = occ({
      bodyHash: 'caller2',
      package: 'pkg-a',
      calls: [null, 'not-an-object', { to: 'not-an-array' }, { to: [42] }],
    });
    expect(resolvableCouplingPairs({ a: [malformedEdge] }).size).toBe(0);
  });
});

describe('boundEdgeFeature', () => {
  const functions = {
    a: [
      occ({ bodyHash: 'caller', package: 'pkg-a', calls: [{ to: ['callee'] }] }),
      occ({ bodyHash: 'callee', package: 'pkg-b' }),
    ],
  };

  it('passes through a non-array edge feature unchanged', () => {
    expect(boundEdgeFeature(undefined, functions)).toBeUndefined();
    expect(boundEdgeFeature('not-an-array', functions)).toBe('not-an-array');
  });

  it('passes through an empty edge array unchanged', () => {
    const edge: unknown[] = [];
    expect(boundEdgeFeature(edge, functions)).toBe(edge);
  });

  it('drops rows whose call sites did not survive bounding', () => {
    const edge = [
      { callerPackage: 'pkg-a', calleePackage: 'pkg-b', count: 3 },
      { callerPackage: 'pkg-x', calleePackage: 'pkg-y', count: 1 },
    ];
    const result = boundEdgeFeature(edge, functions) as unknown[];
    expect(result).toEqual([{ callerPackage: 'pkg-a', calleePackage: 'pkg-b', count: 3 }]);
  });

  it('drops malformed rows (non-object, or missing string caller/callee packages)', () => {
    const edge = [
      null,
      'not-an-object',
      { callerPackage: 'pkg-a', calleePackage: 42, count: 1 },
      { calleePackage: 'pkg-b', count: 1 },
    ];
    const result = boundEdgeFeature(edge, functions) as unknown[];
    expect(result).toEqual([]);
  });
});
