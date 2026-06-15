/**
 * @fileoverview Tests for filterFilesByType.
 *
 * The filter is responsible for narrowing the list of matched files to
 * the extensions a check declares — universal checks (no fileTypes) get
 * everything, language-specific checks get only matching extensions.
 */

import { describe, expect, it } from 'vitest';

import { filterFilesByType } from '../file-type-filter.js';

describe('filterFilesByType', () => {
  const files = ['src/a.ts', 'src/b.tsx', 'src/c.js', 'src/d.py', 'src/e.rs', 'no-extension'];

  it('returns every file when fileTypes is undefined (universal check)', () => {
    const out = filterFilesByType(files, undefined);
    expect(out).toEqual(files);
  });

  it('returns every file when fileTypes is an empty array', () => {
    const out = filterFilesByType(files, []);
    expect(out).toEqual(files);
  });

  it('returns only matching extensions when fileTypes is set', () => {
    const out = filterFilesByType(files, ['ts', 'tsx']);
    expect(out).toEqual(['src/a.ts', 'src/b.tsx']);
  });

  it('returns an empty list when no files match the declared extensions', () => {
    const out = filterFilesByType(files, ['rb']);
    expect(out).toEqual([]);
  });

  it('excludes files without an extension', () => {
    const out = filterFilesByType(files, ['ts']);
    expect(out).toEqual(['src/a.ts']);
    expect(out).not.toContain('no-extension');
  });

  it('returns a new array (does not mutate input)', () => {
    const out = filterFilesByType(files, undefined);
    expect(out).not.toBe(files);
    expect(out).toEqual(files);
  });
});
