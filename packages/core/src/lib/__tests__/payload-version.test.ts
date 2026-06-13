import { describe, it, expect } from 'vitest';

import { extractPayloadVersion } from '../payload-version.js';

describe('extractPayloadVersion', () => {
  it('returns the version when present and numeric > 0', () => {
    expect(extractPayloadVersion({ __version: 1, foo: 'bar' })).toBe(1);
    expect(extractPayloadVersion({ __version: 2 })).toBe(2);
    expect(extractPayloadVersion({ __version: 99, nested: { x: 1 } })).toBe(99);
  });

  it('returns undefined for legacy / missing / empty', () => {
    expect(extractPayloadVersion({})).toBeUndefined();
    expect(extractPayloadVersion({ foo: 1 })).toBeUndefined();
    expect(extractPayloadVersion(null)).toBeUndefined();
    expect(extractPayloadVersion(undefined)).toBeUndefined();
    expect(extractPayloadVersion('string')).toBeUndefined();
    expect(extractPayloadVersion(123)).toBeUndefined();
    expect(extractPayloadVersion([])).toBeUndefined();
  });

  it('returns undefined for invalid numeric values (non-positive, non-finite)', () => {
    expect(extractPayloadVersion({ __version: 0 })).toBeUndefined();
    expect(extractPayloadVersion({ __version: -1 })).toBeUndefined();
    expect(extractPayloadVersion({ __version: NaN })).toBeUndefined();
    expect(extractPayloadVersion({ __version: Infinity })).toBeUndefined();
    expect(extractPayloadVersion({ __version: '2' as any })).toBeUndefined();
    expect(extractPayloadVersion({ __version: true as any })).toBeUndefined();
  });

  it('does not throw on weird inputs', () => {
    expect(() => extractPayloadVersion(Object.create(null))).not.toThrow();
    expect(extractPayloadVersion(Object.create(null))).toBeUndefined();
    const circular: any = {};
    circular.self = circular;
    expect(() => extractPayloadVersion(circular)).not.toThrow();
    expect(extractPayloadVersion(circular)).toBeUndefined();
  });
});
