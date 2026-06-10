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

import {
  buildExportIndex,
  buildPackageManifestIndexFromRoots,
} from '@opensip-tools/graph';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveDeclToHash } from '../../edge-helpers/resolve-decl.js';

import type { CrossPackageContext } from '../../edge-helpers/cross-package-context.js';
import type { ResolverContext } from '../../edge-resolvers/types.js';
import type { Catalog, FunctionOccurrence } from '@opensip-tools/graph';

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
    crossPackage = {
      exportIndex: buildExportIndex(catalog),
      manifestIndex: buildPackageManifestIndexFromRoots([libDir, appDir], root),
    };
  });

  afterAll(() => { rmSync(root, { recursive: true, force: true }); });

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
