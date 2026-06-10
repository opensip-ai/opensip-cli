/**
 * EdgeResolver signature alias (PR-4).
 *
 * Six resolvers (direct-call, property-access, jsx-element,
 * new-expression, polymorphic, catalog-fallback) all share this shape.
 * Declaring each resolver `: EdgeResolver<...>` makes drift a
 * typecheck error.
 */

import type { CrossPackageContext } from '../edge-helpers/cross-package-context.js';
import type { Catalog, ResolverVerdict } from '@opensip-tools/graph';
import type ts from 'typescript';


/** Shared context handed to each edge resolver: catalog, TS program, and project root. */
export interface ResolverContext {
  readonly catalog: Catalog;
  readonly program: ts.Program;
  readonly typeChecker: ts.TypeChecker;
  readonly sourceFile: ts.SourceFile;
  readonly projectDirAbs: string;
  /**
   * Cross-package resolution context (export index + manifest index) — the
   * SAME (import specifier + callee name) → unique exported SOURCE occurrence
   * model the sharded linker uses. Resolvers consult it when the type checker
   * leads them into a workspace package's bodiless `dist/*.d.ts` instead of the
   * source body the catalog holds. Built once per resolve stage.
   */
  readonly crossPackage: CrossPackageContext;
  /**
   * The call site's file: imported binding name → its RAW import specifier
   * (`@scope/pkg`, `./x.js`). Lets a resolver tie a callee name to the package
   * it was imported from, so the export-index lookup is binding-required (no
   * phantom name matches). One index per source file, lazily built + cached by
   * the resolve loop.
   */
  readonly importSpecifiers: ReadonlyMap<string, string>;
}

export type EdgeResolver<N extends ts.Node = ts.Node> = (
  node: N,
  ctx: ResolverContext,
) => ResolverVerdict;
