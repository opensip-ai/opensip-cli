/**
 * Tests for cache invalidation logic.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeFilesFingerprint,
  currentTsCompilerVersion,
  isCatalogValid,
} from '../../cache/invalidate.js';

import type { Catalog } from '../../types.js';

const FAKE_TS_VERSION = '5.7.0';
const FAKE_TSCONFIG = 'fake/tsconfig.json';

function makeCatalog(over: Partial<Catalog> = {}): Catalog {
  return {
    version: '2.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-05-17T00:00:00.000Z',
    tsConfigPath: FAKE_TSCONFIG,
    tsCompilerVersion: FAKE_TS_VERSION,
    filesFingerprint: 'fp',
    functions: {},
    ...over,
  };
}

describe('isCatalogValid', () => {
  it('returns false when ts compiler version differs', () => {
    const cat = makeCatalog({ tsCompilerVersion: '5.6.0' });
    expect(
      isCatalogValid(cat, {
        currentTsCompilerVersion: FAKE_TS_VERSION,
        currentTsConfigPath: FAKE_TSCONFIG,
        currentFiles: [],
      }),
    ).toBe(false);
  });

  it('returns false when tsConfigPath differs', () => {
    const cat = makeCatalog({ tsConfigPath: 'fake/old.json' });
    expect(
      isCatalogValid(cat, {
        currentTsCompilerVersion: FAKE_TS_VERSION,
        currentTsConfigPath: 'fake/new.json',
        currentFiles: [],
      }),
    ).toBe(false);
  });

  it('returns false when filesFingerprint is missing', () => {
    const noFp = makeCatalog();
    const stripped: Catalog = { ...noFp, filesFingerprint: undefined };
    expect(
      isCatalogValid(stripped, {
        currentTsCompilerVersion: FAKE_TS_VERSION,
        currentTsConfigPath: FAKE_TSCONFIG,
        currentFiles: [],
      }),
    ).toBe(false);
  });

  it('returns false when files have changed', () => {
    const cat = makeCatalog({ filesFingerprint: 'old-fp' });
    expect(
      isCatalogValid(cat, {
        currentTsCompilerVersion: FAKE_TS_VERSION,
        currentTsConfigPath: FAKE_TSCONFIG,
        currentFiles: ['fake/does-not-exist.ts'],
      }),
    ).toBe(false);
  });

  it('returns true when all signals agree', () => {
    const fp = computeFilesFingerprint([]);
    const cat = makeCatalog({ filesFingerprint: fp });
    expect(
      isCatalogValid(cat, {
        currentTsCompilerVersion: FAKE_TS_VERSION,
        currentTsConfigPath: FAKE_TSCONFIG,
        currentFiles: [],
      }),
    ).toBe(true);
  });
});

describe('computeFilesFingerprint', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-fp-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts the fingerprint with the file count', () => {
    expect(computeFilesFingerprint([]).startsWith('0')).toBe(true);
    expect(computeFilesFingerprint([join(dir, 'x.ts'), join(dir, 'y.ts')]).startsWith('2')).toBe(true);
  });

  it('reports `missing` for files that fail to stat', () => {
    const fp = computeFilesFingerprint([join(dir, 'does-not-exist.ts')]);
    expect(fp).toContain('missing');
  });

  it('changes when an existing file is modified', () => {
    const f = join(dir, 'a.ts');
    writeFileSync(f, 'one', 'utf8');
    const fp1 = computeFilesFingerprint([f]);
    // Simulate later edit with larger content (different size at least).
    writeFileSync(f, 'one-and-two', 'utf8');
    const fp2 = computeFilesFingerprint([f]);
    expect(fp1).not.toBe(fp2);
  });
});

describe('currentTsCompilerVersion', () => {
  it('returns a non-empty version string', () => {
    expect(typeof currentTsCompilerVersion()).toBe('string');
    expect(currentTsCompilerVersion().length).toBeGreaterThan(0);
  });
});
