import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PathMatcher } from '../path-matcher.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-pm-'));
  mkdirSync(join(testDir, 'src'), { recursive: true });
  mkdirSync(join(testDir, 'src', '__tests__'), { recursive: true });
  writeFileSync(join(testDir, 'src', 'a.ts'), '');
  writeFileSync(join(testDir, 'src', 'b.ts'), '');
  writeFileSync(join(testDir, 'src', 'c.tsx'), '');
  writeFileSync(join(testDir, 'src', 'a.test.ts'), '');
  writeFileSync(join(testDir, 'src', '__tests__', 'd.ts'), '');
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('PathMatcher.match', () => {
  it('expands include globs and returns absolute, sorted paths', async () => {
    const m = PathMatcher.create({ cwd: testDir, include: ['src/*.ts'], exclude: [] });
    const result = await m.match();
    expect(result.files.every((f) => f.startsWith(testDir))).toBe(true);
    const sorted = [...result.files].sort();
    expect(result.files).toEqual(sorted);
  });

  it('respects exclude patterns', async () => {
    const m = PathMatcher.create({
      cwd: testDir,
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts'],
    });
    const files = await m.files();
    expect(files.some((f) => f.endsWith('a.test.ts'))).toBe(false);
  });

  it('honors additionalExcludes alongside exclude', async () => {
    const m = PathMatcher.create({
      cwd: testDir,
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts'],
      additionalExcludes: ['**/__tests__/**'],
    });
    const files = await m.files();
    expect(files.some((f) => f.includes('__tests__'))).toBe(false);
  });

  it('returns durationMs', async () => {
    const m = PathMatcher.create({ cwd: testDir, include: ['src/*.ts'], exclude: [] });
    const result = await m.match();
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('PathMatcher.matches', () => {
  it('returns true for files that match include and not exclude', () => {
    const m = PathMatcher.create({ cwd: testDir, include: ['src/**/*.ts'], exclude: [] });
    expect(m.matches(join(testDir, 'src', 'a.ts'))).toBe(true);
  });

  it('returns false for files outside the include patterns', () => {
    const m = PathMatcher.create({ cwd: testDir, include: ['lib/**/*.ts'], exclude: [] });
    expect(m.matches(join(testDir, 'src', 'a.ts'))).toBe(false);
  });

  it('returns false for files in the exclude list', () => {
    const m = PathMatcher.create({
      cwd: testDir,
      include: ['src/**/*.ts'],
      exclude: ['**/*.test.ts'],
    });
    expect(m.matches(join(testDir, 'src', 'a.test.ts'))).toBe(false);
  });

  it('considers additionalExcludes', () => {
    const m = PathMatcher.create({
      cwd: testDir,
      include: ['src/**/*.ts'],
      exclude: [],
      additionalExcludes: ['**/__tests__/**'],
    });
    expect(m.matches(join(testDir, 'src', '__tests__', 'd.ts'))).toBe(false);
  });
});

describe('PathMatcher composition', () => {
  it('withExcludes returns a new matcher with the union of excludes', () => {
    const base = PathMatcher.create({ cwd: testDir, include: ['src/**/*.ts'], exclude: [] });
    const extended = base.withExcludes(['**/*.test.ts']);
    expect(extended.excludePatterns).toContain('**/*.test.ts');
    // Original is unchanged
    expect(base.excludePatterns).toEqual([]);
  });

  it('noTests excludes the standard test patterns', () => {
    const base = PathMatcher.create({ cwd: testDir, include: ['src/**/*.ts'], exclude: [] });
    const noTests = base.noTests();
    expect(noTests.matches(join(testDir, 'src', 'a.test.ts'))).toBe(false);
    expect(noTests.matches(join(testDir, 'src', '__tests__', 'd.ts'))).toBe(false);
    expect(noTests.matches(join(testDir, 'src', 'a.ts'))).toBe(true);
  });

  it('typescriptOnly narrows include to **/*.{ts,tsx}', () => {
    const base = PathMatcher.create({ cwd: testDir, include: ['src/*'], exclude: [] });
    const ts = base.typescriptOnly();
    // Ensure the include patterns now end in .{ts,tsx}
    expect(ts.includePatterns.every((p) => p.includes('.ts') || p.includes('tsx'))).toBe(true);
  });

  it('exposes cwd / includePatterns / excludePatterns getters', () => {
    const m = PathMatcher.create({
      cwd: testDir,
      include: ['src/**/*.ts'],
      exclude: ['**/build/**'],
    });
    expect(m.cwd).toBe(testDir);
    expect(m.includePatterns).toEqual(['src/**/*.ts']);
    expect(m.excludePatterns).toEqual(['**/build/**']);
  });
});
