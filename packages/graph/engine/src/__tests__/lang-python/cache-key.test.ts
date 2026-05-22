/**
 * Branch-coverage tests for lang-python/cache-key.ts.
 *
 * Exercises the four config-path branches plus the requires-python
 * line extraction.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cacheKey } from '../../lang-python/cache-key.js';

describe('lang-python cacheKey — branches', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-python-cachekey-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns py-unknown-no-config when configPathAbs is undefined', () => {
    expect(cacheKey({ projectDirAbs: dir })).toBe('py-unknown-no-config');
  });

  it('returns py-unknown-no-config when configPathAbs is empty', () => {
    expect(cacheKey({ projectDirAbs: dir, configPathAbs: '' })).toBe('py-unknown-no-config');
  });

  it('returns py-unknown-missing:<path> when the file does not exist', () => {
    const fake = join(dir, 'no-such-file.toml');
    const out = cacheKey({ projectDirAbs: dir, configPathAbs: fake });
    expect(out).toContain('missing:');
    expect(out.startsWith('py-unknown-')).toBe(true);
  });

  it('extracts requires-python and includes it in the key', () => {
    const file = join(dir, 'pyproject.toml');
    writeFileSync(
      file,
      '[project]\nname = "p"\nrequires-python = ">=3.10,<4.0"\n',
      'utf8',
    );
    const out = cacheKey({ projectDirAbs: dir, configPathAbs: file });
    // requires-python should appear (sanitized) in the key.
    expect(out.startsWith('py-')).toBe(true);
    expect(out).toContain('3.10');
  });

  it('falls back to py-unknown-<hash> when requires-python is absent', () => {
    const file = join(dir, 'pyproject.toml');
    writeFileSync(file, '[project]\nname = "p"\n', 'utf8');
    const out = cacheKey({ projectDirAbs: dir, configPathAbs: file });
    expect(out.startsWith('py-unknown-')).toBe(true);
    expect(out).not.toBe('py-unknown-no-config');
  });

  it('produces a stable hash across repeated calls', () => {
    const file = join(dir, 'pyproject.toml');
    writeFileSync(file, '[project]\n', 'utf8');
    const a = cacheKey({ projectDirAbs: dir, configPathAbs: file });
    const b = cacheKey({ projectDirAbs: dir, configPathAbs: file });
    expect(a).toBe(b);
  });
});
