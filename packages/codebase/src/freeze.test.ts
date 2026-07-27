import { describe, expect, it } from 'vitest';

import { byCodePoint, deepFreeze } from './freeze.js';

describe('deepFreeze', () => {
  it('terminates on a self-referential object instead of overflowing the stack', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;

    expect(deepFreeze(cyclic)).toBe(cyclic);
    expect(Object.isFrozen(cyclic)).toBe(true);
  });

  it('terminates on a mutually recursive graph and freezes every reachable node', () => {
    const left: Record<string, unknown> = { side: 'left' };
    const right: Record<string, unknown> = { side: 'right', left };
    left.right = right;

    deepFreeze({ left, right });

    expect(Object.isFrozen(left)).toBe(true);
    expect(Object.isFrozen(right)).toBe(true);
  });

  it('freezes nested arrays and objects reachable from the root', () => {
    const value = deepFreeze({ list: [{ inner: { deep: 1 } }] });

    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.list)).toBe(true);
    expect(Object.isFrozen(value.list[0])).toBe(true);
    expect(Object.isFrozen(value.list[0]?.inner)).toBe(true);
  });

  it('passes primitives and null through untouched', () => {
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(7)).toBe(7);
    expect(deepFreeze('text')).toBe('text');
  });
});

describe('byCodePoint', () => {
  it('orders by code point rather than locale', () => {
    expect(byCodePoint('a', 'b')).toBeLessThan(0);
    expect(byCodePoint('b', 'a')).toBeGreaterThan(0);
    expect(byCodePoint('a', 'a')).toBe(0);
    expect(byCodePoint('a', 'ab')).toBeLessThan(0);
  });
});
