/**
 * Unit tests for the shared edge-identity module (Phase 0 of the graph
 * engine-convergence work) — the ONE home of occurrence/edge keying both engines
 * import. The headline invariant (ADR-0003/0136): edges key by full occurrence
 * identity `ownerEdgeKey(bodyHash, filePath, line, column)`, NOT by `bodyHash`
 * alone, so body-twins (identical bodies in different files — OR twice in one
 * file, differing only by column) never smear each other's edges.
 */

import { describe, expect, it } from 'vitest';

import { bucketEdgesByOwner, ownerEdgeKey, stitchEdgesByOwner } from '../edge-identity.js';

import type { CallEdge, FunctionOccurrence } from '../../../types.js';

function edge(to: readonly string[], line: number, column = 0): CallEdge {
  return {
    to,
    line,
    column,
    resolution: 'semantic',
    confidence: 'high',
    text: 'x()',
  };
}

function occ(
  simpleName: string,
  filePath: string,
  bodyHash: string,
  calls: readonly CallEdge[] = [],
  line = 1,
  column = 0,
): FunctionOccurrence {
  return {
    bodyHash,
    simpleName,
    qualifiedName: `${filePath}.${simpleName}`,
    filePath,
    line,
    column,
    endLine: line,
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
    const a = ownerEdgeKey('TWIN', 'packages/a/x.ts', 1, 0);
    const b = ownerEdgeKey('TWIN', 'packages/b/x.ts', 1, 0);
    expect(a).not.toBe(b);
  });

  it('de-unions SAME-FILE body twins (same hash + file + line, different column)', () => {
    // Two byte-identical arrows on one source line differ only by column — the
    // collision the (bodyHash, filePath) 2-tuple key still smeared (ADR-0136).
    const a = ownerEdgeKey('TWIN', 'f.ts', 5, 2);
    const b = ownerEdgeKey('TWIN', 'f.ts', 5, 40);
    expect(a).not.toBe(b);
  });

  it('is stable for the same (bodyHash, filePath, line, column)', () => {
    expect(ownerEdgeKey('H', 'f.ts', 3, 7)).toBe(ownerEdgeKey('H', 'f.ts', 3, 7));
  });
});

describe('bucketEdgesByOwner', () => {
  it('buckets by ownerEdgeKey, keeping body-twin edges separate', () => {
    const items = [
      { bodyHash: 'TWIN', filePath: 'packages/a/x.ts', line: 1, column: 0, e: edge(['HA'], 2) },
      { bodyHash: 'TWIN', filePath: 'packages/b/x.ts', line: 1, column: 0, e: edge(['HB'], 2) },
    ];
    const byOwner = bucketEdgesByOwner(
      items,
      (i) => ({ bodyHash: i.bodyHash, filePath: i.filePath, line: i.line, column: i.column }),
      (i) => i.e,
    );
    expect(
      byOwner.get(ownerEdgeKey('TWIN', 'packages/a/x.ts', 1, 0))?.flatMap((e) => [...e.to]),
    ).toEqual(['HA']);
    expect(
      byOwner.get(ownerEdgeKey('TWIN', 'packages/b/x.ts', 1, 0))?.flatMap((e) => [...e.to]),
    ).toEqual(['HB']);
  });

  it('keeps SAME-FILE body-twin edges separate (same hash+file+line, differing column)', () => {
    // The collision class ADR-0136 closes: two `TWIN` occurrences in ONE file at
    // (line 5, col 2) and (line 5, col 40). The old 2-tuple key unioned them.
    const items = [
      { bodyHash: 'TWIN', filePath: 'f.ts', line: 5, column: 2, e: edge(['HA'], 5) },
      { bodyHash: 'TWIN', filePath: 'f.ts', line: 5, column: 40, e: edge(['HB'], 5) },
    ];
    const byOwner = bucketEdgesByOwner(
      items,
      (i) => ({ bodyHash: i.bodyHash, filePath: i.filePath, line: i.line, column: i.column }),
      (i) => i.e,
    );
    expect(byOwner.get(ownerEdgeKey('TWIN', 'f.ts', 5, 2))?.flatMap((e) => [...e.to])).toEqual([
      'HA',
    ]);
    expect(byOwner.get(ownerEdgeKey('TWIN', 'f.ts', 5, 40))?.flatMap((e) => [...e.to])).toEqual([
      'HB',
    ]);
  });

  it('appends multiple edges to the same owner in order', () => {
    const items = [
      { bodyHash: 'H', filePath: 'f.ts', line: 1, column: 0, e: edge(['X'], 2) },
      { bodyHash: 'H', filePath: 'f.ts', line: 1, column: 0, e: edge(['Y'], 3) },
    ];
    const byOwner = bucketEdgesByOwner(
      items,
      (i) => ({ bodyHash: i.bodyHash, filePath: i.filePath, line: i.line, column: i.column }),
      (i) => i.e,
    );
    expect(byOwner.get(ownerEdgeKey('H', 'f.ts', 1, 0))?.flatMap((e) => [...e.to])).toEqual([
      'X',
      'Y',
    ]);
  });
});

describe('stitchEdgesByOwner', () => {
  it('attaches recovered edges only to the owning occurrence (no body-twin smearing)', () => {
    const functions = {
      twin: [occ('twin', 'packages/a/x.ts', 'TWIN'), occ('twin', 'packages/b/x.ts', 'TWIN')],
    };
    const byOwner = new Map<string, readonly CallEdge[]>([
      [ownerEdgeKey('TWIN', 'packages/a/x.ts', 1, 0), [edge(['HA'], 2)]],
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

  it('attaches recovered edges only to the owning SAME-FILE twin (ADR-0136)', () => {
    // Two `TWIN` occurrences in ONE file, distinguished only by column. Only the
    // (line 5, col 2) twin has a recovered edge — the (line 5, col 40) twin must
    // stay empty. The old 2-tuple key would have smeared onto both.
    const functions = {
      twin: [occ('twin', 'f.ts', 'TWIN', [], 5, 2), occ('twin', 'f.ts', 'TWIN', [], 5, 40)],
    };
    const byOwner = new Map<string, readonly CallEdge[]>([
      [ownerEdgeKey('TWIN', 'f.ts', 5, 2), [edge(['HA'], 5)]],
    ]);
    const out = stitchEdgesByOwner(functions, byOwner, (o, recovered) => ({
      ...o,
      calls: [...o.calls, ...recovered],
    }));
    const first = out.twin?.find((o) => o.column === 2);
    const second = out.twin?.find((o) => o.column === 40);
    expect(first?.calls.flatMap((e) => [...e.to])).toEqual(['HA']);
    expect(second?.calls).toEqual([]); // its same-line twin's edge did NOT smear
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
      [ownerEdgeKey('H', 'f.ts', 1, 0), [edge(['T'], 2)]],
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
