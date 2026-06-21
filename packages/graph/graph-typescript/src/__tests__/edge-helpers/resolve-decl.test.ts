/**
 * Unit tests for resolveDeclToHash — the seam that maps a type-checker-resolved
 * declaration to a catalog bodyHash, unifying in-project source hashing with the
 * cross-package (`.d.ts` boundary) export-index resolution.
 *
 * The boundary branch is the heart of the exact↔sharded convergence fix: when
 * the type checker leads a `@scope/pkg` call into the package's bodiless
 * `dist/*.d.ts`, resolution re-routes through the SAME (import specifier + callee
 * name) → unique exported SOURCE occurrence model the sharded linker uses —
 * binding-required, so a name with no workspace import never resolves.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildExportIndex, buildPackageManifestIndexFromRoots } from '@opensip-cli/graph';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveDeclToHash } from '../../edge-helpers/resolve-decl.js';

import type { CrossPackageContext } from '../../edge-helpers/cross-package-context.js';
import type { ResolverContext } from '../../edge-resolvers/types.js';
import type { Catalog, FunctionOccurrence } from '@opensip-cli/graph';

const EXPORTED_HASH = 'aaaaaaaaaaaaaaaa';

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

/** A bodiless `.d.ts` declaration node (the type checker's alias target). */
function dtsDecl(): { node: ts.Node; sf: ts.SourceFile } {
  const sf = ts.createSourceFile(
    'helper.d.ts',
    'export declare function helper(): void;',
    ts.ScriptTarget.ES2022,
    true,
  );
  const [node] = sf.statements;
  if (node === undefined) throw new Error('fixture parse produced no statement');
  return { node, sf };
}

describe('resolveDeclToHash — cross-package (.d.ts) boundary resolution', () => {
  // A two-package workspace: `@scope/lib` exports `helper` (the target the
  // catalog holds as SOURCE), `@scope/app` is the caller package.
  const root = mkdtempSync(join(tmpdir(), 'resolve-decl-'));
  const libDir = join(root, 'packages', 'lib');
  const appDir = join(root, 'packages', 'app');

  let crossPackage: CrossPackageContext;
  let catalog: Catalog;

  beforeAll(() => {
    mkdirSync(libDir, { recursive: true });
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(libDir, 'package.json'), JSON.stringify({ name: '@scope/lib' }));
    writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: '@scope/app' }));

    catalog = {
      version: '3.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'x',
      cacheKey: 'k',
      functions: {
        helper: [occ('helper', 'packages/lib/src/helper.ts', EXPORTED_HASH)],
      },
    };
    const manifestIndex = buildPackageManifestIndexFromRoots([libDir, appDir], root);
    crossPackage = {
      // Key the export index by package NAME (pass the manifest) so it aligns
      // with the group `resolveSpecifierToPackage` returns — the production pairing.
      exportIndex: buildExportIndex(catalog, manifestIndex),
      manifestIndex,
    };
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function ctxWith(importSpecifiers: ReadonlyMap<string, string>): ResolverContext {
    return {
      catalog,
      // The program/checker/sourceFile are unused by the boundary branch.
      program: undefined as unknown as ts.Program,
      typeChecker: undefined as unknown as ts.TypeChecker,
      sourceFile: undefined as unknown as ts.SourceFile,
      projectDirAbs: root,
      crossPackage,
      importSpecifiers,
    };
  }

  it('resolves a `.d.ts` decl to the SOURCE occurrence when the name is a workspace import', () => {
    const { node, sf } = dtsDecl();
    const ctx = ctxWith(new Map([['helper', '@scope/lib']]));
    expect(resolveDeclToHash(node, sf, ['helper'], ctx)).toBe(EXPORTED_HASH);
  });

  it('declines a `.d.ts` decl with NO import binding (eliminates name-collision phantoms)', () => {
    const { node, sf } = dtsDecl();
    const ctx = ctxWith(new Map()); // `helper` not imported here
    expect(resolveDeclToHash(node, sf, ['helper'], ctx)).toBeNull();
  });

  it('declines a `.d.ts` decl bound to an EXTERNAL package (not a workspace pkg)', () => {
    const { node, sf } = dtsDecl();
    const ctx = ctxWith(new Map([['helper', 'some-external-pkg']]));
    expect(resolveDeclToHash(node, sf, ['helper'], ctx)).toBeNull();
  });

  it('uses a distinct binding name (namespace receiver) while looking up the callee name', () => {
    const { node, sf } = dtsDecl();
    // `ns` carries the workspace specifier; the exported callee name is `helper`.
    const ctx = ctxWith(new Map([['ns', '@scope/lib']]));
    expect(resolveDeclToHash(node, sf, ['helper'], ctx, ['helper', 'ns'])).toBe(EXPORTED_HASH);
  });
});

describe('resolveDeclToHash — intra-package .d.ts→source method pin', () => {
  // A method call `recv.m()` whose receiver type flows through the OWNER
  // package's OWN published `dist/*.d.ts` (so the checker attests the decl in the
  // `.d.ts`, with NO import binding for the method name). The intra-package pin
  // maps that dist decl back to its SOURCE occurrence — resolving in BOTH engines
  // (the target is in-shard) — while a CROSS-package method target declines
  // (symmetry: it lives in another shard the in-shard pass can't reach).
  const root = mkdtempSync(join(tmpdir(), 'resolve-decl-dts-'));
  const libDir = join(root, 'packages', 'lib');
  const appDir = join(root, 'packages', 'app');
  const GETALL_HASH = 'cccccccccccccccc';
  let catalog: Catalog;
  let crossPackage: CrossPackageContext;

  beforeAll(() => {
    mkdirSync(libDir, { recursive: true });
    mkdirSync(appDir, { recursive: true });
    writeFileSync(join(libDir, 'package.json'), JSON.stringify({ name: '@scope/lib' }));
    writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: '@scope/app' }));
    catalog = {
      version: '3.0',
      tool: 'graph',
      language: 'typescript',
      builtAt: 'x',
      cacheKey: 'k',
      functions: { getAll: [occ('getAll', 'packages/lib/src/registry.ts', GETALL_HASH)] },
    };
    const manifestIndex = buildPackageManifestIndexFromRoots([libDir, appDir], root);
    crossPackage = {
      exportIndex: buildExportIndex(catalog, manifestIndex),
      manifestIndex,
    };
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** A bodiless `dist/*.d.ts` decl at `lib`'s built output. */
  function libDistDecl(): { node: ts.Node; sf: ts.SourceFile } {
    const sf = ts.createSourceFile(
      join(libDir, 'dist', 'registry.d.ts'),
      'export declare class R { getAll(): void; }',
      ts.ScriptTarget.ES2022,
      true,
    );
    const [node] = sf.statements;
    if (node === undefined) throw new Error('fixture parse produced no statement');
    return { node, sf };
  }

  /** ctx whose OWNER file is `ownerAbs` (no import binding → boundary path declines). */
  function ctxOwnedBy(ownerAbs: string): ResolverContext {
    return {
      catalog,
      program: undefined as unknown as ts.Program,
      typeChecker: undefined as unknown as ts.TypeChecker,
      sourceFile: { fileName: ownerAbs } as ts.SourceFile,
      projectDirAbs: root,
      crossPackage,
      importSpecifiers: new Map(),
    };
  }

  it('resolves when the OWNER is in the SAME package as the dist decl', () => {
    const { node, sf } = libDistDecl();
    const ctx = ctxOwnedBy(join(libDir, 'src', 'caller.ts'));
    expect(resolveDeclToHash(node, sf, ['getAll'], ctx)).toBe(GETALL_HASH);
  });

  it('declines when the OWNER is in a DIFFERENT package (cross-shard, left to the completeness floor)', () => {
    const { node, sf } = libDistDecl();
    const ctx = ctxOwnedBy(join(appDir, 'src', 'caller.ts'));
    expect(resolveDeclToHash(node, sf, ['getAll'], ctx)).toBeNull();
  });
});
