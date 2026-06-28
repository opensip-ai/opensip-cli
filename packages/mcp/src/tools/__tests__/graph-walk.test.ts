/**
 * `boundedBfs` unit coverage (Task 6.1 — the shared MCP traversal primitive).
 *
 * Cycle-safety, depth bounding, node-cap → `truncated`, and goal-directed
 * walk + `reconstructPath` — the three behaviors `who_calls` / `callees_of` /
 * `trace_path` all rely on.
 */

import { describe, expect, it } from 'vitest';

import { boundedBfs, MAX_WALK_NODES, reconstructPath } from '../graph-walk.js';

/** Build an adjacency map from `{ node: [neighbors] }`. */
function adj(spec: Record<string, readonly string[]>): Map<string, readonly string[]> {
  return new Map(Object.entries(spec));
}

describe('boundedBfs', () => {
  it('reaches all nodes in discovery order, excluding the start', () => {
    const edges = adj({ a: ['b', 'c'], b: ['d'], c: ['d'], d: [] });
    const walk = boundedBfs(edges, 'a', { depth: 5, cap: MAX_WALK_NODES });
    expect(walk.order).toEqual(['b', 'c', 'd']);
    expect(walk.truncated).toBe(false);
    expect(walk.foundGoal).toBe(false);
  });

  it('is cycle-safe (a ⇄ b never re-enters)', () => {
    const edges = adj({ a: ['b'], b: ['a', 'c'], c: ['a'] });
    const walk = boundedBfs(edges, 'a', { depth: 5, cap: MAX_WALK_NODES });
    expect(walk.order).toEqual(['b', 'c']);
    expect(walk.truncated).toBe(false);
  });

  it('bounds the walk to `depth` BFS levels', () => {
    const edges = adj({ a: ['b'], b: ['c'], c: ['d'], d: ['e'], e: [] });
    const shallow = boundedBfs(edges, 'a', { depth: 2, cap: MAX_WALK_NODES });
    expect(shallow.order).toEqual(['b', 'c']); // levels 1 + 2 only
  });

  it('clamps an out-of-range depth to the hard maximum (5)', () => {
    const chain = adj({
      a: ['b'],
      b: ['c'],
      c: ['d'],
      d: ['e'],
      e: ['f'],
      f: ['g'],
      g: [],
    });
    const walk = boundedBfs(chain, 'a', { depth: 999, cap: MAX_WALK_NODES });
    // Depth is hard-capped at 5 levels even when asked for 999.
    expect(walk.order).toEqual(['b', 'c', 'd', 'e', 'f']);
  });

  it('caps discovered nodes and reports `truncated`', () => {
    const edges = adj({ a: ['b', 'c', 'd', 'e'] });
    const walk = boundedBfs(edges, 'a', { depth: 5, cap: 2 });
    expect(walk.order).toHaveLength(2);
    expect(walk.truncated).toBe(true);
  });

  it('falls back to MAX_WALK_NODES when cap <= 0', () => {
    const edges = adj({ a: ['b', 'c'] });
    const walk = boundedBfs(edges, 'a', { depth: 5, cap: 0 });
    expect(walk.order).toEqual(['b', 'c']);
    expect(walk.truncated).toBe(false);
  });

  it('returns the moment a goal node is reached and records parents', () => {
    const edges = adj({ a: ['b', 'x'], b: ['c'], c: ['goal'], x: [], goal: [] });
    const walk = boundedBfs(edges, 'a', { depth: 5, cap: MAX_WALK_NODES, goal: 'goal' });
    expect(walk.foundGoal).toBe(true);
    const path = reconstructPath(walk.parents, 'a', 'goal');
    expect(path).toEqual(['a', 'b', 'c', 'goal']);
  });

  it('reports foundGoal:false when the goal is unreachable within the bound', () => {
    const edges = adj({ a: ['b'], b: [], goal: [] });
    const walk = boundedBfs(edges, 'a', { depth: 5, cap: MAX_WALK_NODES, goal: 'goal' });
    expect(walk.foundGoal).toBe(false);
  });
});
