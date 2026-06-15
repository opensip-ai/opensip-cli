import { describe, expect, it } from 'vitest';

import { collectCheckObjects, isCheck } from '../check-types.js';
import { defineCheck } from '../define-check.js';

const noopRun = (): null => null;

const checkA = defineCheck({
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'check-a',
  description: 'a',
  tags: ['quality'],
  analyze: () => [],
});

const checkB = defineCheck({
  id: '22222222-2222-4222-8222-222222222222',
  slug: 'check-b',
  description: 'b',
  tags: ['quality'],
  analyze: () => [],
});

describe('isCheck', () => {
  it('returns true for a Check produced by defineCheck', () => {
    expect(isCheck(checkA)).toBe(true);
  });

  it('returns false for null / undefined / primitives', () => {
    expect(isCheck(null)).toBe(false);
    expect(isCheck(undefined)).toBe(false);
    expect(isCheck(42)).toBe(false);
    expect(isCheck('check')).toBe(false);
  });

  it('returns false for an object missing config.execute', () => {
    expect(isCheck({ config: { id: 'x', slug: 'y' }, run: noopRun })).toBe(false);
  });
});

describe('collectCheckObjects', () => {
  it('returns a flat list of Check instances from a flat barrel', () => {
    const out = collectCheckObjects({ checkA, checkB });
    expect(out).toHaveLength(2);
    expect(new Set(out.map((c) => c.config.slug))).toEqual(new Set(['check-a', 'check-b']));
  });

  it('recurses into nested object exports', () => {
    const out = collectCheckObjects({
      quality: { checkA },
      security: { nested: { checkB } },
    });
    expect(out).toHaveLength(2);
  });

  it('deduplicates by config.id when the same check appears multiple times', () => {
    const out = collectCheckObjects({
      direct: checkA,
      reExport: checkA,
      nested: { checkA },
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.config.slug).toBe('check-a');
  });

  it('skips non-Check values (numbers, arrays, primitives)', () => {
    const out = collectCheckObjects({
      checkA,
      meta: 'description',
      version: 1,
      // Arrays must NOT be traversed — they are typically the `checks`
      // re-export the loader handles separately.
      checksArray: [checkB],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.config.slug).toBe('check-a');
  });

  it('threads a shared seen set across multiple calls', () => {
    const seen = new Set<string>();
    const first = collectCheckObjects({ checkA }, seen);
    const second = collectCheckObjects({ checkA, checkB }, seen);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]?.config.slug).toBe('check-b');
  });
});
