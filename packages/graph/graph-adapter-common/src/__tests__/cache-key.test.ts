/**
 * Focused tests for graph-adapter-common/cache-key.ts.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeConfigCacheKey } from '../cache-key.js';

describe('makeConfigCacheKey — resolutionMode', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gac-cachekey-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends resolutionMode to the key', () => {
    const cacheKey = makeConfigCacheKey({ prefix: 'go' });
    expect(cacheKey({ projectDirAbs: dir, resolutionMode: 'exact' })).toBe('go-no-config-exact');
    expect(cacheKey({ projectDirAbs: dir, resolutionMode: 'fast' })).toBe('go-no-config-fast');
  });

  it('distinguishes resolution modes for the same config content', () => {
    const file = join(dir, 'go.mod');
    writeFileSync(file, 'module example\n', 'utf8');
    const cacheKey = makeConfigCacheKey({ prefix: 'go' });
    const exact = cacheKey({
      projectDirAbs: dir,
      configPathAbs: file,
      resolutionMode: 'exact',
    });
    const fast = cacheKey({
      projectDirAbs: dir,
      configPathAbs: file,
      resolutionMode: 'fast',
    });
    expect(exact).not.toBe(fast);
    expect(exact.endsWith('-exact')).toBe(true);
    expect(fast.endsWith('-fast')).toBe(true);
  });
});
