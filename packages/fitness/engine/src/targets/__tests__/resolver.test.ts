import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveTargetFiles } from '../resolver.js';

import type { Target } from '../types.js';

let testDir: string;

const stub = (include: string[], exclude: string[] = []): Target => ({
  config: { name: 't', description: 't', include, exclude },
});

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-resolver-'));
  mkdirSync(join(testDir, 'src'), { recursive: true });
  mkdirSync(join(testDir, 'src', 'sub'), { recursive: true });
  mkdirSync(join(testDir, 'tests'), { recursive: true });
  writeFileSync(join(testDir, 'src', 'a.ts'), '');
  writeFileSync(join(testDir, 'src', 'b.ts'), '');
  writeFileSync(join(testDir, 'src', 'sub', 'c.ts'), '');
  writeFileSync(join(testDir, 'src', 'a.test.ts'), '');
  writeFileSync(join(testDir, 'tests', 'd.ts'), '');
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('resolveTargetFiles', () => {
  it('expands include globs to absolute paths', () => {
    const files = resolveTargetFiles([stub(['src/**/*.ts'])], testDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.startsWith(testDir))).toBe(true);
  });

  it('respects exclude globs', () => {
    const files = resolveTargetFiles([stub(['src/**/*.ts'], ['**/*.test.ts'])], testDir);
    expect(files.some((f) => f.endsWith('.test.ts'))).toBe(false);
    expect(files.some((f) => f.endsWith('a.ts'))).toBe(true);
  });

  it('deduplicates files matching multiple targets', () => {
    const files = resolveTargetFiles([stub(['src/*.ts']), stub(['src/**/*.ts'])], testDir);
    const unique = new Set(files);
    expect(files.length).toBe(unique.size);
  });

  it('returns sorted output', () => {
    const files = resolveTargetFiles([stub(['src/**/*.ts'])], testDir);
    const sorted = [...files].sort();
    expect(files).toEqual(sorted);
  });

  it('returns empty when nothing matches', () => {
    expect(resolveTargetFiles([stub(['nonexistent/**'])], testDir)).toEqual([]);
  });

  it('combines results across multiple targets', () => {
    const files = resolveTargetFiles([stub(['src/a.ts']), stub(['tests/d.ts'])], testDir);
    expect(files.some((f) => f.endsWith('a.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('d.ts'))).toBe(true);
  });
});
