/**
 * Tests for the cache read/write round trip and the cache write
 * SystemError handling.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readCatalog } from '../../cache/read.js';
import { writeCatalog } from '../../cache/write.js';
import { CatalogIntegrityError } from '../../errors.js';

import type { Catalog } from '../../types.js';

function makeCatalog(over: Partial<Catalog> = {}): Catalog {
  return {
    version: '2.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-05-17T00:00:00.000Z',
    tsConfigPath: 'fake/tsconfig.json',
    tsCompilerVersion: '5.7.0',
    filesFingerprint: '1\nsrc/a.ts|0|0',
    functions: { foo: [] as never[] },
    ...over,
  };
}

describe('cache write/read round trip', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'graph-cache-'));
    path = join(dir, 'cache', 'catalog.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes and reads back an equivalent catalog', () => {
    const cat = makeCatalog();
    writeCatalog(path, cat);
    const readBack = readCatalog(path);
    expect(readBack).not.toBeNull();
    expect(readBack?.tool).toBe('graph');
    expect(readBack?.language).toBe('typescript');
    expect(readBack?.version).toBe('2.0');
  });

  it('returns null on cache miss (file not present)', () => {
    expect(readCatalog(join(dir, 'never-written.json'))).toBeNull();
  });

  it('returns null on version mismatch', () => {
    mkdirSync(join(dir, 'cache'), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...makeCatalog(), version: '0.1' }), 'utf8');
    expect(readCatalog(path)).toBeNull();
  });

  it('returns null on malformed JSON', () => {
    mkdirSync(join(dir, 'cache'), { recursive: true });
    writeFileSync(path, 'not json', 'utf8');
    expect(readCatalog(path)).toBeNull();
  });

  it('throws CatalogIntegrityError when tool/language do not match', () => {
    mkdirSync(join(dir, 'cache'), { recursive: true });
    const wrong = { ...makeCatalog(), tool: 'wrong' };
    writeFileSync(path, JSON.stringify(wrong), 'utf8');
    expect(() => readCatalog(path)).toThrow(CatalogIntegrityError);
  });

  it('writeCatalog wraps fs errors as SystemError', () => {
    const filePath = join(dir, 'block');
    writeFileSync(filePath, 'x', 'utf8');
    const bad = join(filePath, 'sub', 'catalog.json');
    expect(() => writeCatalog(bad, makeCatalog())).toThrow(/Failed to write graph catalog/);
  });
});
