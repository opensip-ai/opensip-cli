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

import { cacheKey } from '../cache-key.js';

describe('lang-typescript cacheKey — branches', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-ts-cachekey-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns ts-<version>-no-tsconfig when configPathAbs is undefined', () => {
    const out = cacheKey({ projectDirAbs: dir, resolutionMode: 'exact' });
    expect(out).toContain('-no-tsconfig');
    expect(out.startsWith('ts-')).toBe(true);
  });

  it('returns ts-<version>-no-tsconfig when configPathAbs is empty', () => {
    const out = cacheKey({ projectDirAbs: dir, configPathAbs: '', resolutionMode: 'exact' });
    expect(out).toContain('-no-tsconfig');
  });

  it('returns ts-<version>-missing:<path> when the tsconfig does not exist', () => {
    const fake = join(dir, 'tsconfig.json');
    const out = cacheKey({ projectDirAbs: dir, configPathAbs: fake, resolutionMode: 'exact' });
    expect(out).toContain('missing:');
  });

  it('returns a stable ts-<version>-<hash> when the tsconfig is readable', () => {
    const file = join(dir, 'tsconfig.json');
    writeFileSync(file, '{"compilerOptions": {"target": "ES2022"}}', 'utf8');
    const a = cacheKey({ projectDirAbs: dir, configPathAbs: file, resolutionMode: 'exact' });
    const b = cacheKey({ projectDirAbs: dir, configPathAbs: file, resolutionMode: 'exact' });
    expect(a).toBe(b);
    expect(a.startsWith('ts-')).toBe(true);
    expect(a).not.toContain('no-tsconfig');
  });

  it('folds the adapter package version into the key (F5)', () => {
    const file = join(dir, 'tsconfig.json');
    writeFileSync(file, '{"compilerOptions": {"target": "ES2022"}}', 'utf8');
    const out = cacheKey({ projectDirAbs: dir, configPathAbs: file, resolutionMode: 'exact' });
    // ts-<tsVersion>-adapter-<adapterVersion>-<mode>-<hash>
    expect(out).toMatch(/-adapter-\d+\.\d+\.\d+-/);
  });

  it('changes the key when an extends-base edit changes resolution (F2)', () => {
    // base + extending config; editing the base's compilerOptions must change
    // the RESOLVED options the key hashes — even though the named file is byte-
    // identical across the two reads.
    const base = join(dir, 'tsconfig.base.json');
    const file = join(dir, 'tsconfig.json');
    writeFileSync(file, `{"extends": "./tsconfig.base.json", "compilerOptions": {}}`, 'utf8');

    writeFileSync(
      base,
      `{"compilerOptions": {"baseUrl": ".", "paths": {"@a/*": ["a/*"]}}}`,
      'utf8',
    );
    const before = cacheKey({ projectDirAbs: dir, configPathAbs: file, resolutionMode: 'exact' });

    writeFileSync(
      base,
      `{"compilerOptions": {"baseUrl": ".", "paths": {"@a/*": ["DIFFERENT/*"]}}}`,
      'utf8',
    );
    const after = cacheKey({ projectDirAbs: dir, configPathAbs: file, resolutionMode: 'exact' });

    expect(after).not.toBe(before);
  });

  it('is location-independent (same resolved options under a different root ⇒ same key)', () => {
    const file = join(dir, 'tsconfig.json');
    writeFileSync(file, '{"compilerOptions": {"target": "ES2022", "strict": true}}', 'utf8');
    const a = cacheKey({ projectDirAbs: dir, configPathAbs: file, resolutionMode: 'exact' });
    const dir2 = mkdtempSync(join(tmpdir(), 'graph-ts-cachekey2-'));
    try {
      const file2 = join(dir2, 'tsconfig.json');
      writeFileSync(file2, '{"compilerOptions": {"target": "ES2022", "strict": true}}', 'utf8');
      const b = cacheKey({ projectDirAbs: dir2, configPathAbs: file2, resolutionMode: 'exact' });
      expect(b).toBe(a);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('distinguishes resolution modes (fast vs exact ⇒ distinct keys)', () => {
    const file = join(dir, 'tsconfig.json');
    writeFileSync(file, '{"compilerOptions": {"target": "ES2022"}}', 'utf8');
    const exact = cacheKey({ projectDirAbs: dir, configPathAbs: file, resolutionMode: 'exact' });
    const fast = cacheKey({ projectDirAbs: dir, configPathAbs: file, resolutionMode: 'fast' });
    expect(exact).not.toBe(fast);
  });
});
