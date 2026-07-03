import { describe, expect, it } from 'vitest';

import { boundedJson } from '../bounded-json.js';

describe('boundedJson', () => {
  it('keeps SARIF-safe primitive values and rejects unsupported primitives', () => {
    expect(boundedJson(null)).toBeNull();
    expect(boundedJson('x'.repeat(600))).toBe('x'.repeat(500));
    expect(boundedJson(42)).toBe(42);
    expect(boundedJson(Number.NaN)).toBeUndefined();
    expect(boundedJson(true)).toBe(true);
    expect(boundedJson(undefined)).toBeUndefined();
    expect(boundedJson(Symbol('x'))).toBeUndefined();
  });

  it('bounds arrays, objects, depth, and unsupported nested values', () => {
    const object = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [`k${index}`, index]),
    );

    expect(boundedJson(Array.from({ length: 12 }, (_, index) => index))).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(Object.keys((boundedJson(object) ?? {}) as Record<string, unknown>)).toEqual([
      'k0',
      'k1',
      'k2',
      'k3',
      'k4',
      'k5',
      'k6',
      'k7',
      'k8',
      'k9',
      'k10',
      'k11',
      'k12',
      'k13',
      'k14',
      'k15',
    ]);
    expect(
      boundedJson({
        keep: ['a', { nested: true }],
        drop: () => undefined,
        tooDeep: { a: { b: { c: 'dropped' } } },
      }),
    ).toEqual({
      keep: ['a', { nested: true }],
    });
  });

  it('omits empty containers and attaches nested completed frames to parent containers', () => {
    expect(boundedJson([])).toBeUndefined();
    expect(boundedJson({})).toBeUndefined();
    expect(boundedJson([{ a: 1 }, { b: [2] }])).toEqual([{ a: 1 }, { b: [2] }]);
    expect(boundedJson({ array: [1], object: { value: 'ok' } })).toEqual({
      array: [1],
      object: { value: 'ok' },
    });
  });
});
