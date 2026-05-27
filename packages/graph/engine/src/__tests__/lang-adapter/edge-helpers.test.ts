/**
 * Unit tests for the shared edge-helper utilities.
 *
 * These helpers live on the lang-adapter contract layer; any adapter
 * resolver consumes them to push CallEdges into the
 * `edgesByOwner` map and to keep per-confidence counters in sync. The
 * tests exercise both helpers directly so any future change to the
 * 80-char truncation contract or the creation-edge text prefix is
 * caught at the unit level instead of via downstream adapter tests.
 */

import { describe, expect, it } from 'vitest';

import {
  appendEdge,
  CALL_EDGE_TEXT_MAX,
  CREATION_EDGE_PREFIX,
  CREATION_EDGE_TEXT_MAX,
  createMutableStats,
  pushCreationEdge,
  truncateForCallEdge,
} from '../../lang-adapter/edge-helpers.js';

import type { CallEdge } from '../../types.js';

function makeEdge(over: Partial<CallEdge> = {}): CallEdge {
  return {
    to: ['hash-1'],
    line: 1,
    column: 0,
    resolution: 'static',
    confidence: 'high',
    text: 'fn()',
    discarded: false,
    ...over,
  };
}

describe('truncateForCallEdge', () => {
  it('passes short strings through unchanged', () => {
    expect(truncateForCallEdge('fn()')).toBe('fn()');
  });

  it('returns the input unchanged when it equals the max length', () => {
    const right = 'x'.repeat(CALL_EDGE_TEXT_MAX);
    expect(truncateForCallEdge(right)).toBe(right);
  });

  it('truncates and ellipsizes strings over the max length', () => {
    const tooLong = 'x'.repeat(CALL_EDGE_TEXT_MAX + 20);
    const out = truncateForCallEdge(tooLong);
    expect(out.length).toBe(CALL_EDGE_TEXT_MAX);
    expect(out.endsWith('...')).toBe(true);
  });
});

describe('appendEdge', () => {
  it('creates the owner bucket on the first push', () => {
    const map = new Map<string, CallEdge[]>();
    const edge = makeEdge();
    appendEdge(map, 'owner-a', edge);
    expect(map.get('owner-a')).toEqual([edge]);
  });

  it('appends to an existing owner bucket on subsequent pushes', () => {
    const map = new Map<string, CallEdge[]>();
    const e1 = makeEdge({ line: 1 });
    const e2 = makeEdge({ line: 2 });
    appendEdge(map, 'owner-a', e1);
    appendEdge(map, 'owner-a', e2);
    expect(map.get('owner-a')).toEqual([e1, e2]);
  });

  it('keeps distinct buckets isolated', () => {
    const map = new Map<string, CallEdge[]>();
    appendEdge(map, 'owner-a', makeEdge({ line: 1 }));
    appendEdge(map, 'owner-b', makeEdge({ line: 5 }));
    expect(map.get('owner-a')).toHaveLength(1);
    expect(map.get('owner-b')).toHaveLength(1);
  });
});

describe('createMutableStats', () => {
  it('initializes every counter at zero', () => {
    const s = createMutableStats();
    expect(s.totalCallSites).toBe(0);
    expect(s.resolvedHigh).toBe(0);
    expect(s.resolvedMedium).toBe(0);
    expect(s.resolvedLow).toBe(0);
    expect(s.unresolved).toBe(0);
  });

  it('apply() bumps unresolved when the edge has no resolved targets', () => {
    const s = createMutableStats();
    s.apply(makeEdge({ to: [], confidence: 'low' }));
    expect(s.unresolved).toBe(1);
    expect(s.resolvedHigh).toBe(0);
  });

  it('apply() bumps resolvedHigh for a high-confidence edge', () => {
    const s = createMutableStats();
    s.apply(makeEdge({ confidence: 'high' }));
    expect(s.resolvedHigh).toBe(1);
  });

  it('apply() bumps resolvedMedium for a medium-confidence edge', () => {
    const s = createMutableStats();
    s.apply(makeEdge({ confidence: 'medium' }));
    expect(s.resolvedMedium).toBe(1);
  });

  it('apply() bumps resolvedLow for a low-confidence edge', () => {
    const s = createMutableStats();
    s.apply(makeEdge({ confidence: 'low' }));
    expect(s.resolvedLow).toBe(1);
  });

  it('apply() never touches totalCallSites — that stays the resolver caller’s job', () => {
    const s = createMutableStats();
    s.apply(makeEdge({ confidence: 'high' }));
    s.apply(makeEdge({ to: [], confidence: 'low' }));
    expect(s.totalCallSites).toBe(0);
  });
});

describe('pushCreationEdge', () => {
  it('prefixes [creates] and bumps total+high counters', () => {
    const map = new Map<string, CallEdge[]>();
    const stats = createMutableStats();
    pushCreationEdge(
      { dummy: true },
      { dummy: true },
      'owner-1',
      'child-1',
      map,
      stats,
      () => ({ line: 10, column: 4, text: '() => {}' }),
    );
    const edges = map.get('owner-1');
    expect(edges).toBeDefined();
    expect(edges).toHaveLength(1);
    const edge = edges?.[0];
    expect(edge?.text.startsWith(CREATION_EDGE_PREFIX)).toBe(true);
    expect(edge?.text).toBe(`${CREATION_EDGE_PREFIX}() => {}`);
    expect(edge?.to).toEqual(['child-1']);
    expect(edge?.resolution).toBe('static');
    expect(edge?.confidence).toBe('high');
    expect(stats.totalCallSites).toBe(1);
    expect(stats.resolvedHigh).toBe(1);
  });

  it('truncates inner source text so the total stays within the 80-char contract', () => {
    const map = new Map<string, CallEdge[]>();
    const stats = createMutableStats();
    const inner = 'x'.repeat(CREATION_EDGE_TEXT_MAX + 50);
    pushCreationEdge(
      { dummy: true },
      { dummy: true },
      'owner-1',
      'child-1',
      map,
      stats,
      () => ({ line: 1, column: 0, text: inner }),
    );
    const edge = map.get('owner-1')?.[0];
    expect(edge).toBeDefined();
    // total length always ≤ CALL_EDGE_TEXT_MAX
    expect((edge?.text.length ?? 0) <= CALL_EDGE_TEXT_MAX).toBe(true);
    expect(edge?.text.endsWith('...')).toBe(true);
    expect(edge?.text.startsWith(CREATION_EDGE_PREFIX)).toBe(true);
  });

  it('forwards line/column from the position callback', () => {
    const map = new Map<string, CallEdge[]>();
    const stats = createMutableStats();
    pushCreationEdge(
      { dummy: true },
      { dummy: true },
      'owner-1',
      'child-1',
      map,
      stats,
      () => ({ line: 42, column: 7, text: '() => null' }),
    );
    const edge = map.get('owner-1')?.[0];
    expect(edge?.line).toBe(42);
    expect(edge?.column).toBe(7);
  });
});
