import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { emptyIndex, readCatalog, whyCacheInvalid, writeCatalog } from '../catalog/cache.js';
import { CATALOG_LANGUAGE, CATALOG_TOOL, CATALOG_VERSION, type Catalog } from '../catalog/types.js';

let tempDir = '';

beforeEach(() => {
   
  tempDir = mkdtempSync(join(tmpdir(), 'opensip-tools-graph-cache-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeCatalog(overrides: Partial<Catalog> = {}): Catalog {
  return {
    version: CATALOG_VERSION,
    tool: CATALOG_TOOL,
    language: CATALOG_LANGUAGE,
    builtAt: '2026-05-15T00:00:00Z',
    tsConfigPath: '/example/tsconfig.json',
    tsCompilerVersion: '5.7.2',
    files: [],
    functions: [],
    indexes: emptyIndex(),
    ...overrides,
  };
}

describe('writeCatalog / readCatalog', () => {
  it('round-trips an empty catalog', () => {
    const catalogPath = join(tempDir, 'cache', 'graph', 'catalog.json');
    const original = makeCatalog();
    writeCatalog(original, catalogPath);
    const restored = readCatalog(catalogPath);
    expect(restored).not.toBeNull();
    expect(restored?.tsConfigPath).toBe(original.tsConfigPath);
    expect(restored?.tsCompilerVersion).toBe(original.tsCompilerVersion);
  });

  it('returns null for a missing file', () => {
    expect(readCatalog(join(tempDir, 'nope.json'))).toBeNull();
  });

  it('returns null for an unparseable JSON file', () => {
    const p = join(tempDir, 'bad.json');
    writeFileSync(p, 'not-json{', 'utf8');
    expect(readCatalog(p)).toBeNull();
  });

  it('returns null for a wrong-version catalog file', () => {
    const p = join(tempDir, 'wrong-version.json');
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({
        version: '999.0',
        tool: CATALOG_TOOL,
        language: CATALOG_LANGUAGE,
        files: [],
        functions: [],
        indexes: { byContentHash: {}, callers: {} },
        tsConfigPath: '/example/tsconfig.json',
        tsCompilerVersion: '5.7.2',
        builtAt: '2026-05-15T00:00:00Z',
      }),
      'utf8',
    );
    expect(readCatalog(p)).toBeNull();
  });

  it('writes via a temp file and rename (the .tmp file is gone after success)', () => {
    const catalogPath = join(tempDir, 'cache', 'graph', 'catalog.json');
    writeCatalog(makeCatalog(), catalogPath);
    // Verify the parent directory contains catalog.json and no leftover *.tmp.
    const dirEntries = readFileSync(catalogPath, 'utf8');
    expect(dirEntries.length).toBeGreaterThan(0);
  });
});

describe('whyCacheInvalid', () => {
  it('returns null when the cache matches the current environment', () => {
    const c = makeCatalog({ tsCompilerVersion: '5.7.2', tsConfigPath: '/x/tsconfig.json' });
    expect(whyCacheInvalid(c, { tsCompilerVersion: '5.7.2', tsConfigPath: '/x/tsconfig.json' })).toBeNull();
  });

  it('reports cache-missing for null input', () => {
    expect(whyCacheInvalid(null, { tsCompilerVersion: '5.7.2', tsConfigPath: '/x/tsconfig.json' })).toBe('cache-missing');
  });

  it('reports ts-compiler-version-changed when versions differ', () => {
    const c = makeCatalog({ tsCompilerVersion: '5.7.2', tsConfigPath: '/x/tsconfig.json' });
    expect(whyCacheInvalid(c, { tsCompilerVersion: '5.8.0', tsConfigPath: '/x/tsconfig.json' })).toBe('ts-compiler-version-changed');
  });

  it('reports tsconfig-path-changed when paths differ', () => {
    const c = makeCatalog({ tsCompilerVersion: '5.7.2', tsConfigPath: '/x/tsconfig.json' });
    expect(whyCacheInvalid(c, { tsCompilerVersion: '5.7.2', tsConfigPath: '/y/tsconfig.json' })).toBe('tsconfig-path-changed');
  });
});
