/**
 * Unit coverage for the canonical file-set primitives — the single definition
 * of "which files the graph tool analyzes," shared by both build engines
 * (Phase 1, graph-sharded-exact-parity). Exercises every branch of
 * `isFixturePath` + `resolveCanonicalFileSet`.
 */

import { describe, expect, it } from 'vitest';

import { isFixturePath, resolveCanonicalFileSet } from '../canonical-file-set.js';

describe('isFixturePath', () => {
  it('matches a `/__fixtures__/` segment anywhere in the path', () => {
    expect(isFixturePath('packages/alpha/src/__fixtures__/sample.ts')).toBe(true);
    expect(isFixturePath('a/__fixtures__/b/c.ts')).toBe(true);
  });

  it('does NOT match production or real test files', () => {
    expect(isFixturePath('packages/alpha/src/index.ts')).toBe(false);
    expect(isFixturePath('packages/beta/src/__tests__/index.test.ts')).toBe(false);
    // A bare `fixtures` dir without the dunder segment is NOT a fixture path.
    expect(isFixturePath('packages/x/fixtures/data.ts')).toBe(false);
    // `__fixtures__` as a filename stem (not a path segment) is not matched.
    expect(isFixturePath('packages/x/__fixtures__data.ts')).toBe(false);
  });

  it('normalizes Windows backslash separators before matching', () => {
    expect(isFixturePath(String.raw`packages\alpha\src\__fixtures__\sample.ts`)).toBe(true);
    expect(isFixturePath(String.raw`packages\alpha\src\index.ts`)).toBe(false);
  });
});

describe('resolveCanonicalFileSet', () => {
  it('drops fixture paths and keeps everything else, preserving order', () => {
    const input = [
      'packages/a/src/index.ts',
      'packages/a/src/__fixtures__/sample.ts',
      'packages/b/src/__tests__/index.ts',
      'scripts/root.ts',
    ];
    expect(resolveCanonicalFileSet(input)).toEqual([
      'packages/a/src/index.ts',
      'packages/b/src/__tests__/index.ts',
      'scripts/root.ts',
    ]);
  });

  it('returns a new array (pure) and is a no-op when no fixtures are present', () => {
    const input = ['a.ts', 'b.ts'];
    const out = resolveCanonicalFileSet(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  it('handles an empty input', () => {
    expect(resolveCanonicalFileSet([])).toEqual([]);
  });
});
