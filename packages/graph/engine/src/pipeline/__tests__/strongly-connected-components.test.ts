import { describe, expect, it } from 'vitest';

import { stronglyConnectedComponents } from '../strongly-connected-components.js';

function reversed<T>(values: readonly T[]): T[] {
  return values.reduceRight<T[]>((output, value) => {
    output.push(value);
    return output;
  }, []);
}

function components(adjacency: Readonly<Record<string, readonly string[]>>) {
  return stronglyConnectedComponents(Object.keys(adjacency), (node) => adjacency[node] ?? []);
}

describe('stronglyConnectedComponents', () => {
  it('handles an empty graph', () => {
    expect(stronglyConnectedComponents([], () => [])).toEqual([]);
  });

  it('is stack-safe for a deep acyclic chain', () => {
    const size = 20_000;
    const nodes = Array.from({ length: size }, (_, index) => `n${String(index).padStart(5, '0')}`);
    const result = stronglyConnectedComponents(nodes, (node) => {
      const index = Number(node.slice(1));
      return index + 1 < size ? [nodes[index + 1]] : [];
    });
    expect(result).toHaveLength(size);
    expect(result[0]).toEqual(['n00000']);
    expect(result.at(-1)).toEqual(['n19999']);
  });

  it('returns self-loops, multi-node cycles, and disconnected singletons', () => {
    expect(
      components({
        a: ['a'],
        b: ['c'],
        c: ['d'],
        d: ['b'],
        e: [],
      }),
    ).toEqual([['a'], ['b', 'c', 'd'], ['e']]);
  });

  it('ignores neighbors outside the declared node set', () => {
    expect(components({ a: ['outside'], b: ['a'] })).toEqual([['a'], ['b']]);
  });

  it('is deterministic across neighbor order and uses Unicode code-point order', () => {
    const supplementary = '\u{10000}';
    const bmp = '\uE000';
    const nodes = ['z', supplementary, bmp];
    const forward = stronglyConnectedComponents(nodes, () => [...nodes]);
    const reverse = stronglyConnectedComponents(reversed(nodes), () => reversed(nodes));
    expect(forward).toEqual([
      [bmp, supplementary, 'z'].sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!),
    ]);
    expect(reverse).toEqual(forward);
  });

  it('reads each high-degree adjacency list once', () => {
    const size = 2000;
    const nodes = Array.from({ length: size }, (_, index) => `n${String(index)}`);
    let neighborCalls = 0;
    const result = stronglyConnectedComponents(nodes, (node) => {
      neighborCalls++;
      return node === 'n0' ? nodes.slice(1) : [];
    });
    expect(result).toHaveLength(size);
    expect(neighborCalls).toBe(size);
  });
});
