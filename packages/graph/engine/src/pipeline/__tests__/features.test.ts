/**
 * Feature-derivation tests (Plan C) — golden columns, lazy union, determinism,
 * and parity against the reference algorithms ported from the old dashboard
 * client JS (`indexes.ts` blast, `scc.ts` Tarjan, `view-coupling.ts`
 * aggregation). The fixture exercises a blast hub, a 2-cycle and a 3-cycle, a
 * cross-package call, an entry point, an orphan, and a test-only function.
 */

import { describe, it, expect } from 'vitest';

import { buildFeatures } from '../features.js';
import { buildIndexes } from '../indexes.js';

import type { Catalog, FunctionOccurrence, GraphConfig, Indexes } from '../../types.js';

function occ(
  over: Partial<FunctionOccurrence> & { bodyHash: string; simpleName: string; package: string },
): FunctionOccurrence {
  return {
    qualifiedName: `${over.package}.${over.simpleName}`,
    filePath: `packages/${over.package}/src/${over.simpleName}.ts`,
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
    ...over,
  };
}

function call(to: string): NonNullable<FunctionOccurrence['calls']>[number] {
  return { to: [to], line: 1, column: 0, resolution: 'static', confidence: 'high', text: 'f()' };
}

function catalogOf(functions: Record<string, FunctionOccurrence[]>): Catalog {
  return { version: '3.0', tool: 'graph', language: 'typescript', builtAt: 'x', cacheKey: 'k', functions };
}

const CONFIG: GraphConfig = {};

/**
 * Fixture topology (bodyHash → role):
 *  - entry (exported, name-match 'main') → calls hub
 *  - hub: called directly by d1,d2,d3 (3 direct) and transitively reached by
 *    t1→d1, t2→d2 (2 transitive). Spans depth ≤ 5.
 *  - 2-cycle: c2a ⇄ c2b (same package 'core')
 *  - 3-cycle: c3a → c3b → c3c → c3a, with c3a in 'core', c3c in 'cli'
 *    (crosses packages).
 *  - cross-package: entry (cli) → hub (core) is a cross-package edge.
 *  - orphan: standalone internal fn with no callers, not exported, not reachable.
 *  - testOnly: production fn whose only caller lives in a test file.
 */
function makeFixture(): { catalog: Catalog; indexes: Indexes } {
  const entry = occ({ bodyHash: 'entry', simpleName: 'main', package: 'cli', visibility: 'exported', calls: [call('hub')] });
  const hub = occ({ bodyHash: 'hub', simpleName: 'hub', package: 'core', endLine: 20 }); // bodyLines 20
  const d1 = occ({ bodyHash: 'd1', simpleName: 'd1', package: 'core', calls: [call('hub')] });
  const d2 = occ({ bodyHash: 'd2', simpleName: 'd2', package: 'core', calls: [call('hub')] });
  const d3 = occ({ bodyHash: 'd3', simpleName: 'd3', package: 'core', calls: [call('hub')] });
  const t1 = occ({ bodyHash: 't1', simpleName: 't1', package: 'core', calls: [call('d1')] });
  const t2 = occ({ bodyHash: 't2', simpleName: 't2', package: 'core', calls: [call('d2')] });

  const c2a = occ({ bodyHash: 'c2a', simpleName: 'c2a', package: 'core', calls: [call('c2b')] });
  const c2b = occ({ bodyHash: 'c2b', simpleName: 'c2b', package: 'core', calls: [call('c2a')] });

  const c3a = occ({ bodyHash: 'c3a', simpleName: 'c3a', package: 'core', calls: [call('c3b')] });
  const c3b = occ({ bodyHash: 'c3b', simpleName: 'c3b', package: 'core', calls: [call('c3c')] });
  const c3c = occ({ bodyHash: 'c3c', simpleName: 'c3c', package: 'cli', calls: [call('c3a')] });

  const orphan = occ({ bodyHash: 'orphan', simpleName: 'orphan', package: 'core', visibility: 'module-local' });

  const prod = occ({ bodyHash: 'prod', simpleName: 'prod', package: 'core', visibility: 'module-local' });
  const testCaller = occ({
    bodyHash: 'tc', simpleName: 'tc', package: 'core',
    filePath: 'packages/core/src/__tests__/tc.test.ts', inTestFile: true, calls: [call('prod')],
  });

  const catalog = catalogOf({
    main: [entry], hub: [hub], d1: [d1], d2: [d2], d3: [d3], t1: [t1], t2: [t2],
    c2a: [c2a], c2b: [c2b], c3a: [c3a], c3b: [c3b], c3c: [c3c],
    orphan: [orphan], prod: [prod], tc: [testCaller],
  });
  return { catalog, indexes: buildIndexes(catalog) };
}

describe('buildFeatures — bodyLines', () => {
  it('is endLine − line + 1 for every occurrence', () => {
    const { catalog, indexes } = makeFixture();
    const f = buildFeatures(catalog, indexes, CONFIG, ['bodyLines']);
    for (const [hash, o] of indexes.byBodyHash) {
      expect(f.function.get(hash)?.bodyLines).toBe(o.endLine - o.line + 1);
    }
    expect(f.function.get('hub')?.bodyLines).toBe(20);
  });
});

describe('buildFeatures — blast (golden)', () => {
  it('computes direct/transitive/score for the hub', () => {
    const { catalog, indexes } = makeFixture();
    const f = buildFeatures(catalog, indexes, CONFIG, ['blast']);
    const hubBlast = f.function.get('hub')?.blast;
    // direct callers of hub: d1, d2, d3 → 3. transitive: t1 (→d1), t2 (→d2),
    // and entry (→hub is direct, not transitive). t1/t2 are the depth-2 reach. → 2.
    expect(hubBlast).toEqual({ direct: 4, transitive: 2, score: 4 + 0.5 * 2 });
  });
});

describe('buildFeatures — scc (golden + determinism)', () => {
  it('returns the 2-cycle and 3-cycle with sorted members, sccSize, crossesPackages, stable id', () => {
    const { catalog, indexes } = makeFixture();
    const f = buildFeatures(catalog, indexes, CONFIG, ['scc']);
    const twoCycle = f.scc.find((s) => s.members.includes('c2a'));
    expect(twoCycle).toBeDefined();
    expect(twoCycle?.members).toEqual(['c2a', 'c2b']);
    expect(twoCycle?.sccSize).toBe(2);
    expect(twoCycle?.crossesPackages).toBe(false); // both in 'core'
    expect(twoCycle?.id).toBe('scc:c2a');

    const threeCycle = f.scc.find((s) => s.members.includes('c3a'));
    expect(threeCycle?.members).toEqual(['c3a', 'c3b', 'c3c']);
    expect(threeCycle?.sccSize).toBe(3);
    expect(threeCycle?.crossesPackages).toBe(true); // c3c is in 'cli'
    expect(threeCycle?.id).toBe('scc:c3a');
  });

  it('is deterministic across runs (stable id + order)', () => {
    const { catalog, indexes } = makeFixture();
    const a = buildFeatures(catalog, indexes, CONFIG, ['scc']);
    const b = buildFeatures(catalog, indexes, CONFIG, ['scc']);
    expect(a.scc).toEqual(b.scc);
  });
});

describe('buildFeatures — packageCoupling', () => {
  it('emits the (callerPkg, calleePkg) → count edges and per-package degrees', () => {
    const { catalog, indexes } = makeFixture();
    const f = buildFeatures(catalog, indexes, CONFIG, ['packageCoupling']);
    const edgeOf = (caller: string, callee: string): number | undefined =>
      f.edge.find((e) => e.callerPackage === caller && e.calleePackage === callee)?.count;
    // cli→core: entry→hub, c3c→c3a = 2.
    expect(edgeOf('cli', 'core')).toBe(2);
    // core→core: d1,d2,d3→hub (3), t1→d1, t2→d2 (2), c2a/c2b (2), c3a→c3b (1),
    // tc→prod (1, the test caller lives in packages/core/src/__tests__) = 9.
    expect(edgeOf('core', 'core')).toBe(9);
    // core→cli: c3b→c3c = 1.
    expect(edgeOf('core', 'cli')).toBe(1);
    // package degrees: core calls into core + cli (2 out); cli + core call into core (2 in).
    expect(f.package.get('core')?.couplingOut).toBe(2);
    expect(f.package.get('core')?.couplingIn).toBe(2);
  });
});

describe('buildFeatures — reachability', () => {
  it('reachableFromEntry true for entry+reachable, false for the orphan', () => {
    const { catalog, indexes } = makeFixture();
    const f = buildFeatures(catalog, indexes, CONFIG, ['reachableFromEntry']);
    expect(f.function.get('entry')?.reachableFromEntry).toBe(true);
    expect(f.function.get('hub')?.reachableFromEntry).toBe(true);
    expect(f.function.get('orphan')?.reachableFromEntry).toBe(false);
  });

  it('reachableOnlyFromTests true for the test-only fn, false otherwise', () => {
    const { catalog, indexes } = makeFixture();
    const f = buildFeatures(catalog, indexes, CONFIG, ['reachableOnlyFromTests']);
    expect(f.function.get('prod')?.reachableOnlyFromTests).toBe(true);
    expect(f.function.get('hub')?.reachableOnlyFromTests).toBe(false);
    expect(f.function.get('orphan')?.reachableOnlyFromTests).toBe(false); // no callers at all
  });
});

describe('buildFeatures — lazy union', () => {
  it('["bodyLines"] populates only the function grain bodyLines column', () => {
    const { catalog, indexes } = makeFixture();
    const f = buildFeatures(catalog, indexes, CONFIG, ['bodyLines']);
    expect(f.function.size).toBeGreaterThan(0);
    const row = f.function.get('hub');
    expect(row?.bodyLines).toBe(20);
    expect(row?.blast).toBeUndefined();
    expect(row?.reachableFromEntry).toBeUndefined();
    expect(row?.reachableOnlyFromTests).toBeUndefined();
    expect(f.package.size).toBe(0);
    expect(f.scc.length).toBe(0);
    expect(f.edge.length).toBe(0);
  });

  it('[] returns an all-empty table', () => {
    const { catalog, indexes } = makeFixture();
    const f = buildFeatures(catalog, indexes, CONFIG, []);
    expect(f.function.size).toBe(0);
    expect(f.package.size).toBe(0);
    expect(f.scc.length).toBe(0);
    expect(f.edge.length).toBe(0);
  });

  it('["scc"] populates only the scc array', () => {
    const { catalog, indexes } = makeFixture();
    const f = buildFeatures(catalog, indexes, CONFIG, ['scc']);
    expect(f.scc.length).toBeGreaterThan(0);
    expect(f.function.size).toBe(0);
    expect(f.package.size).toBe(0);
    expect(f.edge.length).toBe(0);
  });
});

// ── Parity vs reference algorithms (faithful TS transcriptions of the old
//    dashboard client JS). Engine computors must equal these on the fixture. ──

const BLAST_MAX_DEPTH = 5;
function referenceBlast(start: string, callers: ReadonlyMap<string, readonly string[]>): {
  direct: number; transitive: number; score: number;
} {
  const directCallers = callers.get(start) ?? [];
  const directSet = new Set(directCallers);
  const visited = new Set<string>([start, ...directSet]);
  const transitiveSet = new Set<string>();
  let frontier = [...directSet];
  for (let depth = 2; depth <= BLAST_MAX_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const parent of callers.get(node) ?? []) {
        if (visited.has(parent)) continue;
        visited.add(parent);
        transitiveSet.add(parent);
        next.push(parent);
      }
    }
    frontier = next;
  }
  const direct = directSet.size;
  const transitive = transitiveSet.size;
  return { direct, transitive, score: direct + 0.5 * transitive };
}

function referenceSccs(indexes: Indexes): string[][] {
  const result: string[][] = [];
  const nodes = [...indexes.byBodyHash.keys()];
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let nextIndex = 0;
  const adj = (v: string): readonly string[] => indexes.callees.get(v) ?? [];
  for (const start of nodes) {
    if (index.has(start)) continue;
    const work: { v: string; ai: number }[] = [{ v: start, ai: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const v = frame.v;
      if (frame.ai === 0) {
        index.set(v, nextIndex);
        lowlink.set(v, nextIndex);
        nextIndex++;
        stack.push(v);
        onStack.add(v);
      }
      const adjV = adj(v);
      let descended = false;
      while (frame.ai < adjV.length) {
        const w = adjV[frame.ai++]!;
        if (!index.has(w)) {
          work.push({ v: w, ai: 0 });
          descended = true;
          break;
        } else if (onStack.has(w)) {
          if (index.get(w)! < lowlink.get(v)!) lowlink.set(v, index.get(w)!);
        }
      }
      if (descended) continue;
      if (lowlink.get(v) === index.get(v)) {
        const scc: string[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
          if (w === v) break;
        }
        scc.sort();
        result.push(scc);
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1]!.v;
        if (lowlink.get(v)! < lowlink.get(parent)!) lowlink.set(parent, lowlink.get(v)!);
      }
    }
  }
  return result;
}

describe('buildFeatures — parity vs prior dashboard outputs', () => {
  it('blast equals the reference bfsBlast for every node', () => {
    const { catalog, indexes } = makeFixture();
    const f = buildFeatures(catalog, indexes, CONFIG, ['blast']);
    for (const hash of indexes.byBodyHash.keys()) {
      expect(f.function.get(hash)?.blast).toEqual(referenceBlast(hash, indexes.callers));
    }
  });

  it('scc member sets equal the reference findSccs (normalized)', () => {
    const { catalog, indexes } = makeFixture();
    const f = buildFeatures(catalog, indexes, CONFIG, ['scc']);
    const norm = (members: readonly string[][]): string[][] =>
      members.map((m) => [...m].sort()).sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
    const engine = norm(f.scc.map((s) => [...s.members]));
    const reference = norm(referenceSccs(indexes));
    expect(engine).toEqual(reference);
  });
});
