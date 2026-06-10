/**
 * Tarjan SCC primitives — `buildAdjacency` and `tarjanSccIds`.
 *
 * `graph-view-model.test.ts` exercises the SCC pass end-to-end through the
 * projector, but only along the "happy" structural paths (clean two-package
 * cycles, self-loops). These tests drive the lower-level primitives directly
 * to lock the defensive/edge branches the projector never produces:
 *
 *  - `buildAdjacency`: an edge whose `source` is not a known node (dropped),
 *    and a duplicate edge (deduped — `includes` guard).
 *  - `tarjanSccIds`: a node id with no adjacency entry (the `?? []` fallback),
 *    a cross-edge into an already-finished node NOT on the stack (the
 *    `onStack` false branch), a self-loop singleton (cyclic), and a trivial
 *    singleton (omitted → null).
 */

import { describe, expect, it } from 'vitest';

import { buildAdjacency, tarjanSccIds } from '../code-paths/graph-scc.js';

describe('buildAdjacency', () => {
  it('builds source → unique target lists for known nodes', () => {
    const adj = buildAdjacency(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
      [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'c' },
      ],
    );
    expect(adj.get('a')).toEqual(['b', 'c']);
    expect(adj.get('b')).toEqual([]);
    expect(adj.get('c')).toEqual([]);
  });

  it('drops an edge whose source is not a registered node (no entry to push into)', () => {
    // `ghost` was never declared as a node → adjacency.get returns undefined →
    // the `out &&` guard short-circuits and the edge is silently dropped.
    const adj = buildAdjacency([{ id: 'a' }], [{ source: 'ghost', target: 'a' }]);
    expect(adj.has('ghost')).toBe(false);
    expect(adj.get('a')).toEqual([]);
    // No stray key was created for the unknown source.
    expect([...adj.keys()]).toEqual(['a']);
  });

  it('dedupes a repeated edge (includes guard) so adjacency stays unique', () => {
    const adj = buildAdjacency(
      [{ id: 'a' }, { id: 'b' }],
      [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'b' },
      ],
    );
    expect(adj.get('a')).toEqual(['b']);
  });
});

describe('tarjanSccIds', () => {
  it('returns an empty map when there are no cycles (all trivial singletons omitted)', () => {
    const nodes = ['a', 'b'];
    const adj = buildAdjacency([{ id: 'a' }, { id: 'b' }], [{ source: 'a', target: 'b' }]);
    const scc = tarjanSccIds(nodes, adj);
    expect(scc.size).toBe(0);
  });

  it('tolerates a node id with no adjacency entry (the `?? []` fallback)', () => {
    // 'lonely' is in the node list but the adjacency map has no key for it.
    const adj = new Map<string, string[]>([['a', []]]);
    const scc = tarjanSccIds(['lonely', 'a'], adj);
    // No cycle → empty, and crucially it does not throw on the missing entry.
    expect(scc.size).toBe(0);
  });

  it('flags a two-node cycle with a shared, deterministic sccId', () => {
    const adj = buildAdjacency(
      [{ id: 'a' }, { id: 'b' }],
      [
        { source: 'a', target: 'b' },
        { source: 'b', target: 'a' },
      ],
    );
    const scc = tarjanSccIds(['a', 'b'], adj);
    expect(scc.get('a')).toBe('scc:a'); // smallest member id
    expect(scc.get('a')).toBe(scc.get('b'));
  });

  it('flags a self-loop singleton as cyclic but omits a trivial singleton', () => {
    const adj = buildAdjacency(
      [{ id: 'self' }, { id: 'plain' }],
      [{ source: 'self', target: 'self' }],
    );
    const scc = tarjanSccIds(['self', 'plain'], adj);
    expect(scc.get('self')).toBe('scc:self');
    expect(scc.has('plain')).toBe(false);
  });

  it('handles a cross-edge into an already-finished node not on the stack (onStack false branch)', () => {
    // Diamond: a→b, a→c, b→d, c→d. When `a` scans `c` after `b`'s subtree
    // (including d) has fully closed, d is visited but NO LONGER on the stack
    // — exercising the `onStack.has(w)` false branch in scanSuccessors. No
    // node is in a cycle, so the result is empty but must not misclassify.
    const adj = buildAdjacency(
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      [
        { source: 'a', target: 'b' },
        { source: 'a', target: 'c' },
        { source: 'b', target: 'd' },
        { source: 'c', target: 'd' },
      ],
    );
    const scc = tarjanSccIds(['a', 'b', 'c', 'd'], adj);
    expect(scc.size).toBe(0);
  });
});
