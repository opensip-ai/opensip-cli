/**
 * toJsonValue / toJsonRecord — ADR-0175 bounded JSON-safe normalizer.
 * These cases are the contract: every result must survive JSON.stringify, and
 * hostile inputs must become deterministic sentinels (not silent drops of the
 * whole bag, and never a throw).
 */

import { describe, expect, it } from 'vitest';

import {
  JSON_VALUE_MAX_ARRAY_ITEMS,
  JSON_VALUE_MAX_DEPTH,
  JSON_VALUE_MAX_OBJECT_KEYS,
  JSON_VALUE_MAX_STRING_LENGTH,
  toJsonRecord,
  toJsonValue,
} from '../json-value.js';

function assertJsonRoundTrip(value: unknown): unknown {
  const normalized = toJsonValue(value);
  const wire = JSON.stringify(normalized);
  expect(() => JSON.parse(wire)).not.toThrow();
  return JSON.parse(wire);
}

describe('toJsonValue', () => {
  it('passes through JSON primitives and plain trees', () => {
    expect(assertJsonRoundTrip(null)).toBe(null);
    expect(assertJsonRoundTrip(true)).toBe(true);
    expect(assertJsonRoundTrip(42)).toBe(42);
    expect(assertJsonRoundTrip('hi')).toBe('hi');
    expect(assertJsonRoundTrip({ a: 1, b: [2, 'x'] })).toEqual({ a: 1, b: [2, 'x'] });
  });

  it('replaces BigInt with a stable decimal+n string (JSON.stringify would throw)', () => {
    expect(assertJsonRoundTrip(1n)).toBe('1n');
    expect(assertJsonRoundTrip({ n: 10n ** 20n })).toEqual({ n: '100000000000000000000n' });
  });

  it('replaces circular references with [Circular]', () => {
    const circular: Record<string, unknown> = { ok: true };
    circular.self = circular;
    expect(assertJsonRoundTrip(circular)).toEqual({ ok: true, self: '[Circular]' });
  });

  it('projects Error to name/message (and bounded cause) instead of empty {}', () => {
    const err = new Error('boom');
    err.name = 'TestError';
    expect(assertJsonRoundTrip(err)).toEqual({ name: 'TestError', message: 'boom' });

    const withCause = new Error('outer');
    withCause.cause = new Error('inner');
    expect(assertJsonRoundTrip(withCause)).toEqual({
      name: 'Error',
      message: 'outer',
      cause: { name: 'Error', message: 'inner' },
    });
  });

  it('catches hostile toJSON and returns [Unserializable]', () => {
    const hostile = {
      toJSON() {
        throw new Error('nope');
      },
    };
    expect(assertJsonRoundTrip(hostile)).toBe('[Unserializable]');
    expect(assertJsonRoundTrip({ bag: hostile })).toEqual({ bag: '[Unserializable]' });
  });

  it('honours cooperative toJSON then re-bounds the projection', () => {
    const cooperative = {
      toJSON() {
        return { ok: true, n: 1n };
      },
    };
    expect(assertJsonRoundTrip(cooperative)).toEqual({ ok: true, n: '1n' });
  });

  it('maps non-finite numbers to deterministic sentinels', () => {
    expect(assertJsonRoundTrip(Number.NaN)).toBe('[NaN]');
    expect(assertJsonRoundTrip(Number.POSITIVE_INFINITY)).toBe('[Infinity]');
    expect(assertJsonRoundTrip(Number.NEGATIVE_INFINITY)).toBe('[-Infinity]');
  });

  it('maps functions, symbols, and free-standing undefined to sentinels', () => {
    expect(assertJsonRoundTrip(() => 1)).toBe('[Function]');
    expect(assertJsonRoundTrip(Symbol('x'))).toBe('[Symbol]');
    expect(assertJsonRoundTrip(undefined)).toBe('[Undefined]');
  });

  it('omits undefined object values (matches JSON.stringify omission)', () => {
    expect(assertJsonRoundTrip({ a: 1, b: undefined })).toEqual({ a: 1 });
  });

  it('converts Date to ISO string', () => {
    expect(assertJsonRoundTrip(new Date('2026-07-20T00:00:00.000Z'))).toBe(
      '2026-07-20T00:00:00.000Z',
    );
  });

  it('caps depth and returns [MaxDepth] for deeper nests', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < JSON_VALUE_MAX_DEPTH + 3; i++) deep = { nested: deep };
    const normalized = toJsonValue(deep) as Record<string, unknown>;
    let cursor: unknown = normalized;
    for (let i = 0; i < JSON_VALUE_MAX_DEPTH; i++) {
      expect(cursor).toEqual(expect.objectContaining({ nested: expect.anything() }));
      cursor = (cursor as { nested: unknown }).nested;
    }
    expect(cursor).toBe('[MaxDepth]');
    expect(() => JSON.stringify(normalized)).not.toThrow();
  });

  it('caps string length with an ellipsis marker', () => {
    const long = 'x'.repeat(JSON_VALUE_MAX_STRING_LENGTH + 50);
    const out = toJsonValue(long) as string;
    expect(out.length).toBe(JSON_VALUE_MAX_STRING_LENGTH);
    expect(out.endsWith('…')).toBe(true);
  });

  it('caps array length and object key count', () => {
    const arr = Array.from({ length: JSON_VALUE_MAX_ARRAY_ITEMS + 10 }, (_, i) => i);
    expect((toJsonValue(arr) as unknown[]).length).toBe(JSON_VALUE_MAX_ARRAY_ITEMS);

    const obj: Record<string, number> = {};
    for (let i = 0; i < JSON_VALUE_MAX_OBJECT_KEYS + 10; i++) obj[`k${i}`] = i;
    expect(Object.keys(toJsonValue(obj) as object).length).toBe(JSON_VALUE_MAX_OBJECT_KEYS);
  });

  it('respects explicit limit overrides', () => {
    expect(toJsonValue({ a: { b: { c: 1 } } }, { maxDepth: 1 })).toEqual({
      a: '[MaxDepth]',
    });
    expect(toJsonValue(['a', 'b', 'c'], { maxArrayItems: 2 })).toEqual(['a', 'b']);
  });
});

describe('toJsonRecord', () => {
  it('always returns a plain object and normalizes nested hostile values', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const out = toJsonRecord({
      count: 2,
      big: 5n,
      circular,
      err: new Error('x'),
    });
    expect(out).toEqual({
      count: 2,
      big: '5n',
      circular: { self: '[Circular]' },
      err: { name: 'Error', message: 'x' },
    });
    expect(() => JSON.stringify(out)).not.toThrow();
  });
});
