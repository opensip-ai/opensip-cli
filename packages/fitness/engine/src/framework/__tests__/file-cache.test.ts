import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ValidationError } from '@opensip-tools/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_PREWARM_PATTERNS, fileCache } from '../file-cache.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-fc-'));
  fileCache.clear();
});

afterEach(() => {
  fileCache.clear();
  rmSync(testDir, { recursive: true, force: true });
});

describe('fileCache.prewarm', () => {
  it('loads matching files into the cache', async () => {
    writeFileSync(join(testDir, 'a.ts'), 'export const a = 1;');
    writeFileSync(join(testDir, 'b.ts'), 'export const b = 2;');
    const stats = await fileCache.prewarm(testDir, ['*.ts']);
    expect(stats.filesLoaded).toBe(2);
    expect(stats.totalBytes).toBeGreaterThan(0);
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
    expect(fileCache.stats.prewarmed).toBe(true);
  });

  it('respects default ignore patterns (skips node_modules)', async () => {
    mkdirSync(join(testDir, 'node_modules', 'foo'), { recursive: true });
    writeFileSync(join(testDir, 'node_modules', 'foo', 'x.ts'), 'export {};');
    writeFileSync(join(testDir, 'app.ts'), 'export const app = 1;');
    await fileCache.prewarm(testDir, ['**/*.ts']);
    expect(fileCache.paths().some((p) => p.includes('node_modules'))).toBe(false);
    expect(fileCache.paths().some((p) => p.endsWith('app.ts'))).toBe(true);
  });

  it('handles multiple patterns and deduplicates', async () => {
    writeFileSync(join(testDir, 'x.ts'), '1');
    const stats = await fileCache.prewarm(testDir, ['*.ts', '**/*.ts']);
    expect(stats.filesLoaded).toBe(1);
  });
});

describe('fileCache.get', () => {
  it('returns content from disk on cache miss and caches it', async () => {
    const path = join(testDir, 'fresh.ts');
    writeFileSync(path, 'fresh content');
    const content = await fileCache.get(path);
    expect(content).toBe('fresh content');
    expect(fileCache.getCached(path)).toBe('fresh content');
  });

  it('returns cached content on hit', async () => {
    const path = join(testDir, 'a.ts');
    writeFileSync(path, 'first');
    await fileCache.prewarm(testDir, ['*.ts']);
    // Mutate the file on disk; cached read still returns first
    writeFileSync(path, 'second');
    expect(await fileCache.get(path)).toBe('first');
  });

  it('throws ValidationError when path is a directory', async () => {
    const dirPath = join(testDir, 'dir');
    mkdirSync(dirPath);
    await expect(fileCache.get(dirPath)).rejects.toThrow(ValidationError);
  });

  it('resolves relative paths against cwd', async () => {
    const abs = join(testDir, 'foo.ts');
    writeFileSync(abs, 'rel');
    process.chdir(testDir);
    const content = await fileCache.get('foo.ts');
    expect(content).toBe('rel');
  });
});

describe('fileCache.getCached', () => {
  it('returns undefined when file is not in cache', () => {
    expect(fileCache.getCached('/nope/nope.ts')).toBeUndefined();
  });

  it('returns cached content after prewarm', async () => {
    writeFileSync(join(testDir, 'q.ts'), 'q');
    await fileCache.prewarm(testDir, ['*.ts']);
    expect(fileCache.getCached(join(testDir, 'q.ts'))).toBe('q');
  });
});

describe('fileCache.exists', () => {
  it('returns true for cached files', async () => {
    writeFileSync(join(testDir, 'e.ts'), 'e');
    await fileCache.prewarm(testDir, ['*.ts']);
    expect(await fileCache.exists(join(testDir, 'e.ts'))).toBe(true);
  });

  it('returns true for files on disk but not yet cached', async () => {
    writeFileSync(join(testDir, 'd.ts'), 'd');
    expect(await fileCache.exists(join(testDir, 'd.ts'))).toBe(true);
  });

  it('returns false when file does not exist', async () => {
    expect(await fileCache.exists(join(testDir, 'missing.ts'))).toBe(false);
  });
});

describe('fileCache.clear', () => {
  it('empties the cache and resets prewarmed flag', async () => {
    writeFileSync(join(testDir, 'x.ts'), 'x');
    await fileCache.prewarm(testDir, ['*.ts']);
    expect(fileCache.stats.size).toBeGreaterThan(0);
    fileCache.clear();
    expect(fileCache.stats.size).toBe(0);
    expect(fileCache.stats.prewarmed).toBe(false);
    expect(fileCache.stats.cleared).toBe(true);
  });
});

describe('fileCache.paths', () => {
  it('returns sorted absolute paths', async () => {
    writeFileSync(join(testDir, 'b.ts'), '');
    writeFileSync(join(testDir, 'a.ts'), '');
    await fileCache.prewarm(testDir, ['*.ts']);
    const paths = fileCache.paths();
    expect(paths.length).toBe(2);
    expect([...paths].sort()).toEqual(paths);
  });
});

describe('DEFAULT_PREWARM_PATTERNS', () => {
  it('includes the major source extensions', () => {
    expect(DEFAULT_PREWARM_PATTERNS).toContain('**/*.ts');
    expect(DEFAULT_PREWARM_PATTERNS).toContain('**/*.tsx');
    expect(DEFAULT_PREWARM_PATTERNS).toContain('**/*.js');
    expect(DEFAULT_PREWARM_PATTERNS).toContain('**/*.json');
  });
});
