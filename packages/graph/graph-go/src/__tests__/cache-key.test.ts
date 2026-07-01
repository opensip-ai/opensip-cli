/**
 * Branch-coverage tests for graph-go/cache-key.ts.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cacheKey } from '../cache-key.js';

describe('graph-go cacheKey — branches', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-go-cachekey-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns go-no-config when configPathAbs is undefined', () => {
    expect(cacheKey({ projectDirAbs: dir, resolutionMode: 'exact' })).toBe('go-no-config-exact');
  });

  it('returns go-no-config when configPathAbs is empty string', () => {
    expect(cacheKey({ projectDirAbs: dir, configPathAbs: '', resolutionMode: 'exact' })).toBe(
      'go-no-config-exact',
    );
  });

  it('returns go-missing:<path> when the config file does not exist', () => {
    const fake = join(dir, 'no-such.sum');
    expect(
      cacheKey({ projectDirAbs: dir, configPathAbs: fake, resolutionMode: 'exact' }),
    ).toContain('missing:');
  });

  it('returns a stable go-<hash> when the config file is readable', () => {
    const file = join(dir, 'go.sum');
    writeFileSync(file, 'example.com/x v1.0.0/go.mod h1:abc\n', 'utf8');
    const a = cacheKey({ projectDirAbs: dir, configPathAbs: file, resolutionMode: 'exact' });
    const b = cacheKey({ projectDirAbs: dir, configPathAbs: file, resolutionMode: 'exact' });
    expect(a).toBe(b);
    expect(a.startsWith('go-')).toBe(true);
    expect(a).not.toBe('go-no-config-exact');
  });

  it('distinguishes resolution modes for the same config content', () => {
    const file = join(dir, 'go.sum');
    writeFileSync(file, 'example.com/x v1.0.0/go.mod h1:abc\n', 'utf8');
    const exact = cacheKey({ projectDirAbs: dir, configPathAbs: file, resolutionMode: 'exact' });
    const fast = cacheKey({ projectDirAbs: dir, configPathAbs: file, resolutionMode: 'fast' });
    expect(exact).not.toBe(fast);
  });

  it('changes when the config file content changes', () => {
    const file = join(dir, 'go.sum');
    writeFileSync(file, 'example.com/x v1.0.0/go.mod h1:aaa\n', 'utf8');
    const a = cacheKey({ projectDirAbs: dir, configPathAbs: file, resolutionMode: 'exact' });
    writeFileSync(file, 'example.com/x v1.0.1/go.mod h1:bbb\n', 'utf8');
    const b = cacheKey({ projectDirAbs: dir, configPathAbs: file, resolutionMode: 'exact' });
    expect(a).not.toBe(b);
  });
});
