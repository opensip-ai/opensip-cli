/**
 * Linker data structures (Phase 1): export symbol index + package manifest
 * index + specifier resolution.
 *
 * The load-bearing invariant: the package key `buildExportIndex` buckets by
 * (`packageOf(filePath)`) and the `packageGroup` `resolveSpecifierToPackage`
 * returns must be IDENTICAL, so Phase 2 can look up
 * `exportIndex.get(resolveSpecifierToPackage(spec).packageGroup)`. The
 * `reconciles ...` test asserts that linkage end-to-end.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildExportIndex,
  buildPackageManifestIndex,
  resolveSpecifierToPackage,
} from '../export-index.js';

import type { Catalog, FunctionOccurrence, Visibility } from '../../../types.js';
import type { Shard } from '../shard-model.js';

function occ(
  simpleName: string,
  filePath: string,
  bodyHash: string,
  visibility: Visibility = 'exported',
): FunctionOccurrence {
  return {
    bodyHash,
    simpleName,
    qualifiedName: `${filePath}.${simpleName}`,
    filePath,
    line: 1,
    column: 0,
    endLine: 1,
    kind: 'function-declaration',
    params: [],
    returnType: null,
    enclosingClass: null,
    decorators: [],
    visibility,
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
  };
}

function catalog(...occs: FunctionOccurrence[]): Catalog {
  const functions: Record<string, FunctionOccurrence[]> = {};
  for (const o of occs) {
    const bucket = functions[o.simpleName];
    if (bucket) bucket.push(o);
    else functions[o.simpleName] = [o];
  }
  return {
    version: '3.0',
    tool: 'graph',
    language: 'typescript',
    builtAt: 'x',
    cacheKey: 'k',
    resolutionMode: 'exact',
    functions,
  };
}

describe('buildExportIndex', () => {
  it('includes exported occurrences and excludes module-local / private', () => {
    const cat = catalog(
      occ('shown', 'packages/core/src/a.ts', 'A', 'exported'),
      occ('localOnly', 'packages/core/src/a.ts', 'B', 'module-local'),
      occ('privateOnly', 'packages/core/src/a.ts', 'C', 'private'),
    );
    const index = buildExportIndex(cat);
    const core = index.get('core');
    expect(core).toBeDefined();
    expect([...(core?.keys() ?? [])]).toEqual(['shown']);
    expect(core?.get('shown')?.map((o) => o.bodyHash)).toEqual(['A']);
    expect(core?.get('localOnly')).toBeUndefined();
    expect(core?.get('privateOnly')).toBeUndefined();
  });

  it('buckets exported occurrences by package group then name across packages', () => {
    const cat = catalog(
      occ('build', 'packages/core/src/a.ts', 'A'),
      occ('build', 'packages/graph/engine/src/b.ts', 'B'),
      occ('run', 'packages/graph/engine/src/c.ts', 'C'),
    );
    const index = buildExportIndex(cat);
    expect([...index.keys()].sort()).toEqual(['core', 'graph']);
    expect(index.get('core')?.get('build')?.map((o) => o.bodyHash)).toEqual(['A']);
    expect(index.get('graph')?.get('build')?.map((o) => o.bodyHash)).toEqual(['B']);
    expect(index.get('graph')?.get('run')?.map((o) => o.bodyHash)).toEqual(['C']);
  });

  it('collects multiple exported occurrences of one name in a package', () => {
    const cat = catalog(
      occ('overload', 'packages/core/src/a.ts', 'A'),
      occ('overload', 'packages/core/src/b.ts', 'B'),
    );
    const index = buildExportIndex(cat);
    expect(index.get('core')?.get('overload')?.map((o) => o.bodyHash).sort()).toEqual(['A', 'B']);
  });

  it('keeps same-named exports in different packages separate (name collision)', () => {
    const cat = catalog(
      occ('serialize', 'packages/core/src/a.ts', 'A'),
      occ('serialize', 'packages/output/src/b.ts', 'B'),
    );
    const index = buildExportIndex(cat);
    expect(index.get('core')?.get('serialize')?.map((o) => o.bodyHash)).toEqual(['A']);
    expect(index.get('output')?.get('serialize')?.map((o) => o.bodyHash)).toEqual(['B']);
  });
});

describe('buildPackageManifestIndex + resolveSpecifierToPackage', () => {
  let projectRoot: string;
  let shards: Shard[];

  beforeAll(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'export-index-'));
    // @opensip-tools/core at packages/core, with subpath exports
    writePackage('packages/core', {
      name: '@opensip-tools/core',
      exports: {
        '.': './dist/index.js',
        './errors': './dist/lib/errors.js',
        './languages/parse-cache.js': './dist/languages/parse-cache.js',
      },
    });
    // unscoped package at packages/output, no exports field
    writePackage('packages/output', { name: 'plain-output' });
    // a package whose name collides nowhere; bare root resolution
    writePackage('packages/graph/engine', { name: '@opensip-tools/graph' });

    shards = [
      shard('pkg:core', 'packages/core'),
      shard('pkg:output', 'packages/output'),
      shard('pkg:graph', 'packages/graph/engine'),
      // a shard pointing at a dir with no package.json — must be skipped, not throw
      shard('pkg:missing', 'packages/nonexistent'),
    ];
  });

  afterAll(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writePackage(relDir: string, manifest: Record<string, unknown>): void {
    const abs = join(projectRoot, relDir);
    mkdirSync(abs, { recursive: true });
    writeFileSync(join(abs, 'package.json'), JSON.stringify(manifest), 'utf8');
  }

  function shard(id: string, relDir: string): Shard {
    return { id, rootDir: join(projectRoot, relDir), files: [] };
  }

  it('indexes each readable package by name and skips missing manifests', () => {
    const index = buildPackageManifestIndex(shards, projectRoot);
    expect([...index.keys()].sort()).toEqual([
      '@opensip-tools/core',
      '@opensip-tools/graph',
      'plain-output',
    ]);
    expect(index.get('@opensip-tools/core')?.dir).toBe('packages/core');
  });

  it('resolves a scoped bare root specifier to its package group', () => {
    const index = buildPackageManifestIndex(shards, projectRoot);
    const resolved = resolveSpecifierToPackage('@opensip-tools/core', index);
    expect(resolved).toEqual({ packageGroup: 'core' });
  });

  it('resolves an unscoped bare specifier', () => {
    const index = buildPackageManifestIndex(shards, projectRoot);
    expect(resolveSpecifierToPackage('plain-output', index)).toEqual({ packageGroup: 'output' });
  });

  it('resolves a subpath declared in exports, carrying the subpath', () => {
    const index = buildPackageManifestIndex(shards, projectRoot);
    expect(resolveSpecifierToPackage('@opensip-tools/core/errors', index)).toEqual({
      packageGroup: 'core',
      subpath: './errors',
    });
    expect(
      resolveSpecifierToPackage('@opensip-tools/core/languages/parse-cache.js', index),
    ).toEqual({ packageGroup: 'core', subpath: './languages/parse-cache.js' });
  });

  it('declines a subpath NOT declared in exports', () => {
    const index = buildPackageManifestIndex(shards, projectRoot);
    expect(resolveSpecifierToPackage('@opensip-tools/core/internal', index)).toBeUndefined();
  });

  it('declines any subpath against a package with no exports field', () => {
    const index = buildPackageManifestIndex(shards, projectRoot);
    expect(resolveSpecifierToPackage('plain-output/sub', index)).toBeUndefined();
  });

  it('returns undefined for an unknown / external package', () => {
    const index = buildPackageManifestIndex(shards, projectRoot);
    expect(resolveSpecifierToPackage('react', index)).toBeUndefined();
    expect(resolveSpecifierToPackage('@scope/unknown', index)).toBeUndefined();
  });

  it('returns undefined for relative or malformed specifiers', () => {
    const index = buildPackageManifestIndex(shards, projectRoot);
    expect(resolveSpecifierToPackage('./local.js', index)).toBeUndefined();
    expect(resolveSpecifierToPackage('', index)).toBeUndefined();
    expect(resolveSpecifierToPackage('@scope', index)).toBeUndefined();
  });

  it('reconciles a resolved packageGroup with buildExportIndex keys (the Phase-2 linkage)', () => {
    const index = buildPackageManifestIndex(shards, projectRoot);
    const cat = catalog(occ('parse', 'packages/core/src/parser.ts', 'P'));
    const exportIndex = buildExportIndex(cat);

    const resolved = resolveSpecifierToPackage('@opensip-tools/core', index);
    expect(resolved).toBeDefined();
    // The whole point: the specifier's group keys straight into the export index.
    const byName = exportIndex.get(resolved?.packageGroup ?? '<none>');
    expect(byName?.get('parse')?.map((o) => o.bodyHash)).toEqual(['P']);
  });
});
