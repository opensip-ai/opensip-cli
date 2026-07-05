import { describe, expect, it } from 'vitest';

import { findOrphanedDisplayKeys } from '../display-parity.js';

describe('findOrphanedDisplayKeys', () => {
  it('returns orphaned display keys in sorted order', () => {
    const checks = [{ config: { slug: 'present' } }];
    expect(
      findOrphanedDisplayKeys(checks, {
        zed: ['z', 'Zed'],
        present: ['p', 'Present'],
        alpha: ['a', 'Alpha'],
      }),
    ).toEqual(['alpha', 'zed']);
  });

  it('returns an empty list for exact display/check parity', () => {
    const checks = [{ config: { slug: 'one' } }, { config: { slug: 'two' } }];
    expect(
      findOrphanedDisplayKeys(checks, {
        one: ['1', 'One'],
        two: ['2', 'Two'],
      }),
    ).toEqual([]);
  });

  it('accepts an empty display map', () => {
    expect(findOrphanedDisplayKeys([{ config: { slug: 'one' } }], {})).toEqual([]);
  });
});
