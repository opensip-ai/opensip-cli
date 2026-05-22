/**
 * Branch-coverage tests for lang-typescript/cache-key.ts.
 *
 * Exercises the four config-path branches and verifies the
 * deterministic output for the same input.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cacheKey } from '../../lang-typescript/cache-key.js';

describe('lang-typescript cacheKey — branches', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-ts-cachekey-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns ts-<version>-no-tsconfig when configPathAbs is undefined', () => {
    const out = cacheKey({ projectDirAbs: dir });
    expect(out).toContain('-no-tsconfig');
    expect(out.startsWith('ts-')).toBe(true);
  });

  it('returns ts-<version>-no-tsconfig when configPathAbs is empty', () => {
    const out = cacheKey({ projectDirAbs: dir, configPathAbs: '' });
    expect(out).toContain('-no-tsconfig');
  });

  it('returns ts-<version>-missing:<path> when the tsconfig does not exist', () => {
    const fake = join(dir, 'tsconfig.json');
    const out = cacheKey({ projectDirAbs: dir, configPathAbs: fake });
    expect(out).toContain('missing:');
  });

  it('returns a stable ts-<version>-<hash> when the tsconfig is readable', () => {
    const file = join(dir, 'tsconfig.json');
    writeFileSync(file, '{"compilerOptions": {"target": "ES2022"}}', 'utf8');
    const a = cacheKey({ projectDirAbs: dir, configPathAbs: file });
    const b = cacheKey({ projectDirAbs: dir, configPathAbs: file });
    expect(a).toBe(b);
    expect(a.startsWith('ts-')).toBe(true);
    expect(a).not.toContain('no-tsconfig');
  });
});
