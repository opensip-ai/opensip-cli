/**
 * Branch-coverage tests for lang-rust/cache-key.ts.
 *
 * Exercises the four config-path branches: undefined / empty,
 * non-existent path, valid file, and the deterministic hash for
 * repeated calls.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cacheKey } from '../cache-key.js';

describe('lang-rust cacheKey — branches', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-rust-cachekey-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns rs-no-config when configPathAbs is undefined', () => {
    expect(cacheKey({ projectDirAbs: dir, resolutionMode: 'exact' })).toBe('rs-no-config');
  });

  it('returns rs-no-config when configPathAbs is empty string', () => {
    expect(cacheKey({ projectDirAbs: dir, configPathAbs: '', resolutionMode: 'exact' })).toBe(
      'rs-no-config',
    );
  });

  it('returns rs-missing:<path> when the config file does not exist', () => {
    const fake = join(dir, 'no-such-file.toml');
    expect(
      cacheKey({ projectDirAbs: dir, configPathAbs: fake, resolutionMode: 'exact' }),
    ).toContain('missing:');
  });

  it('returns a stable rs-<hash> when the config file is readable', () => {
    const file = join(dir, 'Cargo.toml');
    writeFileSync(file, '[package]\nname = "x"\n', 'utf8');
    const a = cacheKey({ projectDirAbs: dir, configPathAbs: file, resolutionMode: 'exact' });
    const b = cacheKey({ projectDirAbs: dir, configPathAbs: file, resolutionMode: 'exact' });
    expect(a).toBe(b);
    expect(a.startsWith('rs-')).toBe(true);
    expect(a).not.toBe('rs-no-config');
  });

  it('changes when the config file content changes', () => {
    const file = join(dir, 'Cargo.toml');
    writeFileSync(file, '[package]\nname = "a"\n', 'utf8');
    const a = cacheKey({ projectDirAbs: dir, configPathAbs: file, resolutionMode: 'exact' });
    writeFileSync(file, '[package]\nname = "b"\n', 'utf8');
    const b = cacheKey({ projectDirAbs: dir, configPathAbs: file, resolutionMode: 'exact' });
    expect(a).not.toBe(b);
  });
});
