/**
 * Tarjan's SCC algorithm — correctness tests over the
 * `indexes.callees` shape used by `findSccs`.
 */

import { describe, expect, it } from 'vitest';

import { dashboardSccJs } from '../code-paths/scc.js';

interface Indexes {
  byBodyHash: Map<string, unknown>;
  callees: Map<string, string[]>;
}

function loadFindSccs(): (idx: Indexes) => string[][] {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, sonarjs/code-eval -- Trusted source.
  const fn = new Function(dashboardSccJs() + '\nreturn findSccs;')() as (idx: Indexes) => string[][];
  return fn;
}

function makeIndexes(adj: Record<string, string[]>): Indexes {
  const byBodyHash = new Map<string, unknown>();
  for (const k of Object.keys(adj)) byBodyHash.set(k, { bodyHash: k });
  const callees = new Map<string, string[]>();
  for (const [k, v] of Object.entries(adj)) callees.set(k, v);
  return { byBodyHash, callees };
}

function sortSccs(sccs: string[][]): string[][] {
  return sccs.map(s => [...s].sort()).sort((a, b) => a.join(',').localeCompare(b.join(',')));
}

describe('Tarjan SCC', () => {
  it('finds a 2-cycle', () => {
    const fn = loadFindSccs();
    const out = fn(makeIndexes({ a: ['b'], b: ['a'] }));
    const big = out.filter(s => s.length >= 2);
    expect(sortSccs(big)).toEqual([['a', 'b']]);
  });

  it('finds a 3-cycle', () => {
    const fn = loadFindSccs();
    const out = fn(makeIndexes({ a: ['b'], b: ['c'], c: ['a'] }));
    const big = out.filter(s => s.length >= 2);
    expect(sortSccs(big)).toEqual([['a', 'b', 'c']]);
  });

  it('finds two disjoint SCCs', () => {
    const fn = loadFindSccs();
    const out = fn(makeIndexes({ a: ['b'], b: ['a'], c: ['d'], d: ['c'] }));
    const big = out.filter(s => s.length >= 2);
    expect(sortSccs(big)).toEqual([['a', 'b'], ['c', 'd']]);
  });

  it('returns no SCCs ≥ 2 when graph is a DAG', () => {
    const fn = loadFindSccs();
    const out = fn(makeIndexes({ a: ['b', 'c'], b: ['c'], c: [] }));
    const big = out.filter(s => s.length >= 2);
    expect(big).toEqual([]);
  });

  it('handles isolated nodes (no SCCs ≥ 2)', () => {
    const fn = loadFindSccs();
    const out = fn(makeIndexes({ a: [], b: [], c: [] }));
    const big = out.filter(s => s.length >= 2);
    expect(big).toEqual([]);
  });

  it('handles an empty graph', () => {
    const fn = loadFindSccs();
    const out = fn(makeIndexes({}));
    expect(out).toEqual([]);
  });
});
