/**
 * Tests for cache invalidation logic.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyCatalog,
  computeFilesFingerprint,
  currentTsCompilerVersion,
  diffFingerprints,
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

describe('classifyCatalog (Wave 4)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-classify-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns `valid` when fingerprints match exactly', () => {
    const f = join(dir, 'a.ts');
    writeFileSync(f, 'x', 'utf8');
    const fp = computeFilesFingerprint([f]);
    const cat = makeCatalog({ filesFingerprint: fp });
    const verdict = classifyCatalog(cat, {
      currentTsCompilerVersion: FAKE_TS_VERSION,
      currentTsConfigPath: FAKE_TSCONFIG,
      currentFiles: [f],
    });
    expect(verdict.kind).toBe('valid');
  });

  it('returns `incremental` with the changed file when one of two files is modified', () => {
    const a = join(dir, 'a.ts');
    const b = join(dir, 'b.ts');
    writeFileSync(a, 'aaaa', 'utf8');
    writeFileSync(b, 'bbbb', 'utf8');
    const fp = computeFilesFingerprint([a, b]);
    const cat = makeCatalog({ filesFingerprint: fp });
    // Simulate edit to b only.
    writeFileSync(b, 'bbbb-modified-much-bigger', 'utf8');
    const verdict = classifyCatalog(cat, {
      currentTsCompilerVersion: FAKE_TS_VERSION,
      currentTsConfigPath: FAKE_TSCONFIG,
      currentFiles: [a, b],
    });
    expect(verdict.kind).toBe('incremental');
    if (verdict.kind === 'incremental') {
      expect(verdict.changedFiles).toEqual([b]);
    }
  });

  it('returns `incremental` listing both an added and a removed file', () => {
    const a = join(dir, 'a.ts');
    const b = join(dir, 'b.ts');
    writeFileSync(a, 'aaaa', 'utf8');
    writeFileSync(b, 'bbbb', 'utf8');
    const fpOriginal = computeFilesFingerprint([a, b]);
    const cat = makeCatalog({ filesFingerprint: fpOriginal });
    // Now: remove b, add c.
    rmSync(b);
    const c = join(dir, 'c.ts');
    writeFileSync(c, 'cccc', 'utf8');
    const verdict = classifyCatalog(cat, {
      currentTsCompilerVersion: FAKE_TS_VERSION,
      currentTsConfigPath: FAKE_TSCONFIG,
      currentFiles: [a, c],
    });
    expect(verdict.kind).toBe('incremental');
    if (verdict.kind === 'incremental') {
      // Both removed-from-cache (b) and added (c) appear as "changed."
      expect(verdict.changedFiles).toEqual([b, c].sort());
    }
  });

  it('returns `invalid` when the compiler version differs (no incremental path)', () => {
    const cat = makeCatalog({ tsCompilerVersion: '5.6.0' });
    const verdict = classifyCatalog(cat, {
      currentTsCompilerVersion: FAKE_TS_VERSION,
      currentTsConfigPath: FAKE_TSCONFIG,
      currentFiles: [],
    });
    expect(verdict.kind).toBe('invalid');
  });

  it('returns `invalid` when the catalog has no fingerprint', () => {
    const stripped: Catalog = { ...makeCatalog(), filesFingerprint: undefined };
    const verdict = classifyCatalog(stripped, {
      currentTsCompilerVersion: FAKE_TS_VERSION,
      currentTsConfigPath: FAKE_TSCONFIG,
      currentFiles: [],
    });
    expect(verdict.kind).toBe('invalid');
  });
});

describe('diffFingerprints', () => {
  it('returns the changed file when one of several has a new mtime', () => {
    const a = '/x/a.ts';
    const b = '/x/b.ts';
    const c = '/x/c.ts';
    const cached = `3\n${a}|100|10\n${b}|200|20\n${c}|300|30`;
    const current = `3\n${a}|100|10\n${b}|999|20\n${c}|300|30`;
    expect(diffFingerprints(cached, current)).toEqual([b]);
  });

  it('flags an added file', () => {
    const cached = `1\n/x/a.ts|100|10`;
    const current = `2\n/x/a.ts|100|10\n/x/new.ts|500|50`;
    expect(diffFingerprints(cached, current)).toEqual(['/x/new.ts']);
  });

  it('flags a removed file', () => {
    const cached = `2\n/x/a.ts|100|10\n/x/gone.ts|400|40`;
    const current = `1\n/x/a.ts|100|10`;
    expect(diffFingerprints(cached, current)).toEqual(['/x/gone.ts']);
  });

  it('returns empty for identical fingerprints', () => {
    const fp = `2\n/x/a.ts|100|10\n/x/b.ts|200|20`;
    expect(diffFingerprints(fp, fp)).toEqual([]);
  });

  it('returns paths sorted lexicographically when multiple files change', () => {
    const cached = `2\n/x/zebra.ts|100|10\n/x/apple.ts|200|20`;
    const current = `2\n/x/zebra.ts|999|10\n/x/apple.ts|999|20`;
    expect(diffFingerprints(cached, current)).toEqual(['/x/apple.ts', '/x/zebra.ts']);
  });
});
