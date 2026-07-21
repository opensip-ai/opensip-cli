import { describe, expect, it } from 'vitest';

import { isFiniteNumber, projectJsonScalarMetadata } from '../json-scalars.js';

describe('isFiniteNumber', () => {
  it('admits finite numbers only (ADR-0180)', () => {
    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(1.5)).toBe(true);
    expect(isFiniteNumber(Number.NaN)).toBe(false);
    expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isFiniteNumber(Number.NEGATIVE_INFINITY)).toBe(false);
    expect(isFiniteNumber('1')).toBe(false);
    expect(isFiniteNumber(null)).toBe(false);
  });
});

describe('projectJsonScalarMetadata', () => {
  it('returns undefined when metadata is missing or has no scalar values', () => {
    expect(projectJsonScalarMetadata(undefined)).toBeUndefined();
    expect(
      projectJsonScalarMetadata({
        nested: { value: 'x' },
        list: ['x'],
        missing: null,
        callback: () => 'x',
      }),
    ).toBeUndefined();
  });

  it('keeps only JSON scalar metadata values', () => {
    expect(
      projectJsonScalarMetadata({
        text: 'value',
        count: 3,
        enabled: false,
        nested: { value: 'x' },
        list: ['x'],
        missing: null,
      }),
    ).toEqual({
      text: 'value',
      count: 3,
      enabled: false,
    });
  });

  it('drops non-finite numbers (ADR-0180; fails on main when NaN passes through)', () => {
    expect(
      projectJsonScalarMetadata({
        ok: 1,
        bad: Number.NaN,
        inf: Number.POSITIVE_INFINITY,
        label: 'x',
      }),
    ).toEqual({ ok: 1, label: 'x' });
  });
});
