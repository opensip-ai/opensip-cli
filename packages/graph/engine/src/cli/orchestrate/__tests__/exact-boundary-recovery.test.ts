/**
 * Exact-engine boundary recovery (Phase 3, Option A) — the helpers that make
 * the single-program (exact) catalog run the SAME post-merge linker as the
 * sharded engine. Covers: the no-op early returns, the package-root walk
 * (found / nested-ancestor / declines at the project root), per-directory
 * memoization, and the end-to-end recovery path against a real on-disk package.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  derivePackageRoots,
  findPackageRoot,
  recoverExactBoundaryEdges,
} from '../exact-boundary-recovery.js';

import type { Catalog, CrossBoundaryCall, FunctionOccurrence } from '../../../types.js';

function occ(simpleName: string, filePath: string, bodyHash: string): FunctionOccurrence {
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
    visibility: 'exported',
    inTestFile: false,
    definedInGenerated: false,
    calls: [],
  };
}

function catalogOf(...occs: FunctionOccurrence[]): Catalog {
  const functions: Record<string, FunctionOccurrence[]> = {};
  for (const o of occs) {
    const bucket = functions[o.simpleName] ?? [];
    functions[o.simpleName] = bucket;
    bucket.push(o);
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

describe('recoverExactBoundaryEdges', () => {
  const cat = catalogOf(occ('f', 'packages/a/src/f.ts', 'h1'));

  it('returns the catalog unchanged when no boundary calls were emitted', () => {
    expect(recoverExactBoundaryEdges({ catalog: cat }, [], '/root')).toBe(cat);
  });

  it('returns the catalog unchanged for an empty boundary-call array', () => {
    expect(recoverExactBoundaryEdges({ catalog: cat, boundaryCalls: [] }, [], '/root')).toBe(cat);
  });
});

describe('findPackageRoot / derivePackageRoots (on-disk walk)', () => {
  let root: string;
  let pkgDir: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'graph-recovery-'));
    pkgDir = join(root, 'packages', 'a');
    mkdirSync(join(pkgDir, 'src'), { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@t/a' }));
    // A bare directory under the project root with NO package.json anywhere up to root.
    mkdirSync(join(root, 'loose'), { recursive: true });
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('finds the nearest ancestor package.json from a nested source dir', () => {
    expect(findPackageRoot(join(pkgDir, 'src'), root)).toBe(pkgDir);
  });

  it('returns the dir itself when it directly contains package.json', () => {
    expect(findPackageRoot(pkgDir, root)).toBe(pkgDir);
  });

  it('declines (null) when no package.json exists up to the project root', () => {
    expect(findPackageRoot(join(root, 'loose'), root)).toBeNull();
  });

  it('dedupes roots and memoizes per directory (two files, same package)', () => {
    const roots = derivePackageRoots(
      [
        join(pkgDir, 'src', 'one.ts'),
        join(pkgDir, 'src', 'two.ts'), // same dir → cache hit, no second walk
        join(root, 'loose', 'x.ts'), // no package → contributes nothing (null branch)
      ],
      root,
    );
    expect(roots).toEqual([pkgDir]);
  });

  it('runs the linker end-to-end when boundary calls are present (declines on external specifier)', () => {
    const cat = catalogOf(occ('g', 'packages/a/src/g.ts', 'hg'));
    const bc: CrossBoundaryCall = {
      ownerHash: 'hg',
      ownerFile: 'packages/a/src/g.ts',
      calleeName: 'somethingExternal',
      importSpecifier: 'lodash', // not a workspace package → linker declines, no throw
      line: 2,
      column: 4,
      text: 'somethingExternal()',
      discarded: false,
    };
    const out = recoverExactBoundaryEdges(
      { catalog: cat, boundaryCalls: [bc] },
      [join(pkgDir, 'src', 'g.ts')],
      root,
    );
    // The full path executed (manifest build + linker); the catalog's functions survive.
    expect(out.functions.g).toBeDefined();
  });
});
