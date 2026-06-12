import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ValidationError } from '@opensip-cli/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileAccessor } from '../file-accessor.js';
import { fileCache } from '../file-cache.js';

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'opensip-fa-'));
  fileCache.clear();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  fileCache.clear();
});

describe('createFileAccessor', () => {
  it('exposes the configured paths via the readonly paths property', () => {
    const acc = createFileAccessor(['/a.ts', '/b.ts']);
    expect(acc.paths).toEqual(['/a.ts', '/b.ts']);
  });

  it('reads file content from disk via fileCache when not preloaded', async () => {
    const path = join(testDir, 'x.ts');
    writeFileSync(path, 'hi');
    const acc = createFileAccessor([path]);
    expect(await acc.read(path)).toBe('hi');
  });

  it('rejects reads of paths not in the configured set', async () => {
    const acc = createFileAccessor(['/allowed.ts']);
    await expect(acc.read('/disallowed.ts')).rejects.toThrow(ValidationError);
  });

  it('caches reads — second call returns the same content even if disk changed', async () => {
    const path = join(testDir, 'cache.ts');
    writeFileSync(path, 'first');
    const acc = createFileAccessor([path]);
    expect(await acc.read(path)).toBe('first');
    writeFileSync(path, 'second');
    // Cached
    expect(await acc.read(path)).toBe('first');
  });

  it('throws ValidationError when a file exceeds 10 MB', async () => {
    const path = join(testDir, 'big.txt');
    // Use Buffer-write to avoid loading 11 MB of string into memory unnecessarily
    writeFileSync(path, Buffer.alloc(11 * 1024 * 1024, 'a'));
    const acc = createFileAccessor([path]);
    await expect(acc.read(path)).rejects.toThrow(/File too large/);
  });

  it('readMany reads multiple files and returns a Map', async () => {
    const a = join(testDir, 'a.ts');
    const b = join(testDir, 'b.ts');
    writeFileSync(a, 'A');
    writeFileSync(b, 'B');
    const acc = createFileAccessor([a, b]);
    const map = await acc.readMany([a, b]);
    expect(map.get(a)).toBe('A');
    expect(map.get(b)).toBe('B');
  });

  it('readAll returns every configured path', async () => {
    const a = join(testDir, 'a.ts');
    writeFileSync(a, 'AA');
    const acc = createFileAccessor([a]);
    const map = await acc.readAll();
    expect(map.size).toBe(1);
    expect(map.get(a)).toBe('AA');
  });

  it('throws when an aborted signal is passed', async () => {
    const ac = new AbortController();
    ac.abort();
    const path = join(testDir, 'z.ts');
    writeFileSync(path, 'z');
    const acc = createFileAccessor([path], { signal: ac.signal });
    await expect(acc.read(path)).rejects.toThrow();
  });

  it('cachedCount reflects internal LRU size', async () => {
    const path = join(testDir, 'cnt.ts');
    writeFileSync(path, 'cnt');
    const acc = createFileAccessor([path]) as unknown as {
      cachedCount: number;
      clearCache: () => void;
      read: (p: string) => Promise<string>;
    };
    expect(acc.cachedCount).toBe(0);
    await acc.read(path);
    expect(acc.cachedCount).toBe(1);
    acc.clearCache();
    expect(acc.cachedCount).toBe(0);
  });

  it('preferentially returns content from the global fileCache when prewarmed', async () => {
    const path = join(testDir, 'p.ts');
    writeFileSync(path, 'on-disk');
    await fileCache.prewarm(testDir, ['p.ts']);
    // Mutate disk; accessor should still return prewarmed content
    writeFileSync(path, 'changed');
    const acc = createFileAccessor([path]);
    expect(await acc.read(path)).toBe('on-disk');
  });

  it('LRU eviction kicks in beyond the configured capacity', async () => {
    const paths: string[] = [];
    for (let i = 0; i < 5; i++) {
      const p = join(testDir, `${i}.ts`);
      writeFileSync(p, String(i));
      paths.push(p);
    }
    const acc = createFileAccessor(paths, { cacheCapacity: 2 }) as unknown as {
      cachedCount: number;
      read: (p: string) => Promise<string>;
    };
    for (const p of paths) await acc.read(p);
    expect(acc.cachedCount).toBe(2);
  });
});
