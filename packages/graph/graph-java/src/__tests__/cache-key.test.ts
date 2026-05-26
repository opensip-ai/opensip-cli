/**
 * Branch-coverage tests for graph-java/cache-key.ts.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cacheKey } from '../cache-key.js';

describe('graph-java cacheKey — branches', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-java-cachekey-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns java-no-config when configPathAbs is undefined', () => {
    expect(cacheKey({ projectDirAbs: dir })).toBe('java-no-config');
  });

  it('returns java-no-config when configPathAbs is empty string', () => {
    expect(cacheKey({ projectDirAbs: dir, configPathAbs: '' })).toBe('java-no-config');
  });

  it('returns java-missing:<path> when the config file does not exist', () => {
    const fake = join(dir, 'no-such.xml');
    expect(cacheKey({ projectDirAbs: dir, configPathAbs: fake })).toContain('missing:');
  });

  it('returns a stable java-<hash> when the config file is readable', () => {
    const file = join(dir, 'pom.xml');
    writeFileSync(file, '<project><groupId>x</groupId></project>\n', 'utf8');
    const a = cacheKey({ projectDirAbs: dir, configPathAbs: file });
    const b = cacheKey({ projectDirAbs: dir, configPathAbs: file });
    expect(a).toBe(b);
    expect(a.startsWith('java-')).toBe(true);
    expect(a).not.toBe('java-no-config');
  });

  it('changes when the config file content changes', () => {
    const file = join(dir, 'pom.xml');
    writeFileSync(file, '<project><groupId>a</groupId></project>\n', 'utf8');
    const a = cacheKey({ projectDirAbs: dir, configPathAbs: file });
    writeFileSync(file, '<project><groupId>b</groupId></project>\n', 'utf8');
    const b = cacheKey({ projectDirAbs: dir, configPathAbs: file });
    expect(a).not.toBe(b);
  });
});
