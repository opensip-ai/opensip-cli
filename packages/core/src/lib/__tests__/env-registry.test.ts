/**
 * EnvRegistry — canonical/alias resolution, coercion, defaults, deprecation, and
 * the unknown-name guard. Each test sets/clears the real `process.env` keys it
 * exercises (and restores them) so the suite stays hermetic.
 */

import { afterEach, describe, it, expect } from 'vitest';

import { EnvRegistry, type EnvVarSpec } from '../env-registry.js';

const TOUCHED = ['OST_TEST_FLAG', 'OST_TEST_VALUE', 'OST_TEST_ALIAS', 'OST_TEST_CANON'];

afterEach(() => {
  for (const key of TOUCHED) delete process.env[key];
});

describe('EnvRegistry', () => {
  it('reads the canonical name and reports the source', () => {
    process.env.OST_TEST_VALUE = 'hello';
    const reg = new EnvRegistry([{ canonical: 'OST_TEST_VALUE', docs: 'x' }]);
    const result = reg.read('OST_TEST_VALUE');
    expect(result.value).toBe('hello');
    expect(result.source).toBe('canonical');
  });

  it('falls back to an alias when the canonical is unset', () => {
    process.env.OST_TEST_ALIAS = 'from-alias';
    const reg = new EnvRegistry([
      { canonical: 'OST_TEST_CANON', aliases: ['OST_TEST_ALIAS'], docs: 'x' },
    ]);
    const result = reg.read('OST_TEST_CANON');
    expect(result.value).toBe('from-alias');
    expect(result.source).toBe('alias');
  });

  it('prefers the canonical over an alias when both are set', () => {
    process.env.OST_TEST_CANON = 'canon';
    process.env.OST_TEST_ALIAS = 'alias';
    const reg = new EnvRegistry([
      { canonical: 'OST_TEST_CANON', aliases: ['OST_TEST_ALIAS'], docs: 'x' },
    ]);
    expect(reg.get('OST_TEST_CANON')).toBe('canon');
  });

  it('coerces the raw value', () => {
    process.env.OST_TEST_FLAG = '1';
    const spec: EnvVarSpec<boolean> = {
      canonical: 'OST_TEST_FLAG',
      coerce: (raw) => raw === '1',
      docs: 'x',
    };
    const reg = new EnvRegistry([spec]);
    expect(reg.get<boolean>('OST_TEST_FLAG')).toBe(true);
  });

  it('applies the default when unset, reporting source=default', () => {
    const reg = new EnvRegistry([{ canonical: 'OST_TEST_VALUE', default: 'fallback', docs: 'x' }]);
    const result = reg.read('OST_TEST_VALUE');
    expect(result.value).toBe('fallback');
    expect(result.source).toBe('default');
  });

  it('returns undefined with source=unset when neither set nor defaulted', () => {
    const reg = new EnvRegistry([{ canonical: 'OST_TEST_VALUE', docs: 'x' }]);
    expect(reg.read('OST_TEST_VALUE')).toEqual({ value: undefined, source: 'unset' });
  });

  it('surfaces the deprecation note on a hit so the caller can warn', () => {
    process.env.OST_TEST_CANON = 'v';
    const reg = new EnvRegistry([
      { canonical: 'OST_TEST_CANON', docs: 'x', deprecated: { since: '2.12.0', use: 'OST_NEW' } },
    ]);
    expect(reg.read('OST_TEST_CANON').deprecated).toEqual({ since: '2.12.0', use: 'OST_NEW' });
  });

  it('describe() returns every registered spec for the generated doc', () => {
    const reg = new EnvRegistry([
      { canonical: 'OST_TEST_CANON', docs: 'a' },
      { canonical: 'OST_TEST_VALUE', docs: 'b' },
    ]);
    expect(
      reg
        .describe()
        .map((s) => s.canonical)
        .sort(),
    ).toEqual(['OST_TEST_CANON', 'OST_TEST_VALUE']);
    expect(reg.has('OST_TEST_CANON')).toBe(true);
    expect(reg.has('NOPE')).toBe(false);
  });

  it('throws on an unknown variable (a host-spec typo is a bug, not silent undefined)', () => {
    const reg = new EnvRegistry([{ canonical: 'OST_TEST_VALUE', docs: 'x' }]);
    expect(() => reg.get('OST_UNDECLARED')).toThrow(/unknown variable 'OST_UNDECLARED'/);
  });
});
