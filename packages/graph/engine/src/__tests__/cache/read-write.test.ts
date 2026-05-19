/**
 * Tests for the cache read/write round trip and the cache write
 * SystemError handling.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { normalizeCatalogForSerialization } from '../../cache/normalize.js';
import { readCatalog } from '../../cache/read.js';
import { writeCatalog } from '../../cache/write.js';
import { CatalogIntegrityError } from '../../errors.js';

import type { Catalog, FunctionOccurrence } from '../../types.js';

function makeCatalog(over: Partial<Catalog> = {}): Catalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: '2026-05-17T00:00:00.000Z',
    cacheKey: 'ts-5.7.0-abcdef0123456789',
    filesFingerprint: '1\nsrc/a.ts|0|0',
    functions: { foo: [] as never[] },
    ...over,
  };
}

function makeOccurrence(over: Partial<FunctionOccurrence>): FunctionOccurrence {
  return {
    bodyHash: 'h',
    simpleName: 'foo',
    qualifiedName: 'src/a.foo',
    filePath: 'src/a.ts',
    line: 1,
    column: 0,
    endLine: 1,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility: 'module-local',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
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
    expect(readBack?.version).toBe('3.0');
    expect(readBack?.cacheKey).toBe('ts-5.7.0-abcdef0123456789');
  });

  it('returns null when reading a v2-format catalog (one cold rebuild path)', () => {
    // A user upgrading from v2 to v3 has a v2 catalog on disk. The
    // reader rejects the version mismatch; the orchestrator falls
    // through to a full rebuild. Verifies the catalog v3 migration
    // story from docs/plans/10-graph-language-pluggability.md §5.
    mkdirSync(join(dir, 'cache'), { recursive: true });
    const v2 = {
      version: '2.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: '2026-05-17T00:00:00.000Z',
      tsConfigPath: 'fake/tsconfig.json',
      tsCompilerVersion: '5.6.0',
      filesFingerprint: '0',
      functions: {},
    };
    writeFileSync(path, JSON.stringify(v2), 'utf8');
    expect(readCatalog(path)).toBeNull();
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

  it('throws CatalogIntegrityError when tool does not match', () => {
    mkdirSync(join(dir, 'cache'), { recursive: true });
    const wrong = { ...makeCatalog(), tool: 'wrong' };
    writeFileSync(path, JSON.stringify(wrong), 'utf8');
    expect(() => readCatalog(path)).toThrow(CatalogIntegrityError);
  });

  it('throws CatalogIntegrityError when cacheKey is missing', () => {
    mkdirSync(join(dir, 'cache'), { recursive: true });
    const stripped = { ...makeCatalog(), cacheKey: '' };
    writeFileSync(path, JSON.stringify(stripped), 'utf8');
    expect(() => readCatalog(path)).toThrow(CatalogIntegrityError);
  });

  it('produces byte-identical output to the legacy JSON.stringify path', () => {
    // The streamed writer must produce the same bytes as the prior
    // implementation: `${JSON.stringify(normalize(cat), null, 2)}\n`.
    // This protects existing on-disk caches from being invalidated by
    // a serialization change.
    const cat = makeCatalog({
      functions: {
        zebra: [makeOccurrence({ simpleName: 'zebra', filePath: 'src/z.ts', bodyHash: 'z' })],
        alpha: [
          makeOccurrence({ simpleName: 'alpha', filePath: 'src/a.ts', line: 5, bodyHash: 'a5' }),
          makeOccurrence({ simpleName: 'alpha', filePath: 'src/a.ts', line: 1, bodyHash: 'a1' }),
        ],
        empty: [],
      },
    });
    writeCatalog(path, cat);
    const written = readFileSync(path, 'utf8');
    const expected = `${JSON.stringify(normalizeCatalogForSerialization(cat), null, 2)}\n`;
    expect(written).toBe(expected);
  });

  it('writes a catalog with an empty functions map identically to JSON.stringify', () => {
    const cat = makeCatalog({ functions: {} });
    writeCatalog(path, cat);
    const written = readFileSync(path, 'utf8');
    const expected = `${JSON.stringify(normalizeCatalogForSerialization(cat), null, 2)}\n`;
    expect(written).toBe(expected);
  });

  it('writeCatalog wraps fs errors as SystemError', () => {
    const filePath = join(dir, 'block');
    writeFileSync(filePath, 'x', 'utf8');
    const bad = join(filePath, 'sub', 'catalog.json');
    expect(() => writeCatalog(bad, makeCatalog())).toThrow(/Failed to write graph catalog/);
  });
});
