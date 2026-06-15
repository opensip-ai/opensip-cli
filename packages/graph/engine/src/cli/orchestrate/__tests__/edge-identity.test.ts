/**
 * Unit tests for the shared edge-identity module (Phase 0 of the graph
 * engine-convergence work) — the ONE home of occurrence/edge keying both engines
 * import. The headline invariant (ADR-0003): edges key by OCCURRENCE
 * `ownerEdgeKey(bodyHash, filePath)`, NOT by `bodyHash` alone, so body-twins
 * (identical bodies in different files) never smear each other's edges.
 */

import { describe, expect, it } from 'vitest';

import { bucketEdgesByOwner, ownerEdgeKey, stitchEdgesByOwner } from '../edge-identity.js';

import type { CallEdge, FunctionOccurrence } from '../../../types.js';

function edge(to: readonly string[], line: number, column = 0): CallEdge {
  return { to, line, column, resolution: 'semantic', confidence: 'high', text: 'x()' };
}

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

describe('ownerEdgeKey', () => {
  it('de-unions body twins (same hash, different files → distinct keys)', () => {
    const a = ownerEdgeKey('TWIN', 'packages/a/x.ts');
    const b = ownerEdgeKey('TWIN', 'packages/b/x.ts');
    expect(a).not.toBe(b);
  });

  it('is stable for the same (bodyHash, filePath)', () => {
    expect(ownerEdgeKey('H', 'f.ts')).toBe(ownerEdgeKey('H', 'f.ts'));
  });
});

describe('bucketEdgesByOwner', () => {
  it('buckets by ownerEdgeKey, keeping body-twin edges separate', () => {
    const items = [
      { bodyHash: 'TWIN', filePath: 'packages/a/x.ts', e: edge(['HA'], 2) },
      { bodyHash: 'TWIN', filePath: 'packages/b/x.ts', e: edge(['HB'], 2) },
    ];
    const byOwner = bucketEdgesByOwner(
      items,
      (i) => ({ bodyHash: i.bodyHash, filePath: i.filePath }),
      (i) => i.e,
    );
    expect(byOwner.get(ownerEdgeKey('TWIN', 'packages/a/x.ts'))?.flatMap((e) => [...e.to])).toEqual(
      ['HA'],
    );
    expect(byOwner.get(ownerEdgeKey('TWIN', 'packages/b/x.ts'))?.flatMap((e) => [...e.to])).toEqual(
      ['HB'],
    );
  });

  it('appends multiple edges to the same owner in order', () => {
    const items = [
      { bodyHash: 'H', filePath: 'f.ts', e: edge(['X'], 2) },
      { bodyHash: 'H', filePath: 'f.ts', e: edge(['Y'], 3) },
    ];
    const byOwner = bucketEdgesByOwner(
      items,
      (i) => ({ bodyHash: i.bodyHash, filePath: i.filePath }),
      (i) => i.e,
    );
    expect(byOwner.get(ownerEdgeKey('H', 'f.ts'))?.flatMap((e) => [...e.to])).toEqual(['X', 'Y']);
  });
});

describe('stitchEdgesByOwner', () => {
  it('attaches recovered edges only to the owning occurrence (no body-twin smearing)', () => {
    const functions = {
      twin: [occ('twin', 'packages/a/x.ts', 'TWIN'), occ('twin', 'packages/b/x.ts', 'TWIN')],
    };
    const byOwner = new Map<string, readonly CallEdge[]>([
      [ownerEdgeKey('TWIN', 'packages/a/x.ts'), [edge(['HA'], 2)]],
    ]);
    const out = stitchEdgesByOwner(functions, byOwner, (o, recovered) => ({
      ...o,
      calls: [...o.calls, ...recovered],
    }));
    const twinA = out.twin?.find((o) => o.filePath === 'packages/a/x.ts');
    const twinB = out.twin?.find((o) => o.filePath === 'packages/b/x.ts');
    expect(twinA?.calls.flatMap((e) => [...e.to])).toEqual(['HA']); // got its edge
    expect(twinB?.calls).toEqual([]); // its twin's edge did NOT smear onto it
  });

  it('returns an occurrence unchanged when it has no recovered edges', () => {
    const original = occ('f', 'f.ts', 'H');
    const functions = { f: [original] };
    const out = stitchEdgesByOwner(functions, new Map(), (o) => ({
      ...o,
      calls: [edge(['NEVER'], 9)],
    }));
    // combine must NOT run for an owner with no recovered edges.
    expect(out.f?.[0]).toBe(original);
  });

  it('runs the combine callback for an owner WITH recovered edges', () => {
    const functions = { f: [occ('f', 'f.ts', 'H', [edge([], 2)])] };
    const byOwner = new Map<string, readonly CallEdge[]>([
      [ownerEdgeKey('H', 'f.ts'), [edge(['T'], 2)]],
    ]);
    // combine drops the empty placeholder at the recovered site, then concats.
    const out = stitchEdgesByOwner(functions, byOwner, (o, recovered) => {
      const at = new Set(recovered.map((e) => `${String(e.line)}:${String(e.column)}`));
      const kept = o.calls.filter(
        (e) => !(e.to.length === 0 && at.has(`${String(e.line)}:${String(e.column)}`)),
      );
      return { ...o, calls: [...kept, ...recovered] };
    });
    expect(out.f?.[0]?.calls.flatMap((e) => [...e.to])).toEqual(['T']);
  });
});
