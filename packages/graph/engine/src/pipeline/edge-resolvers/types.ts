/**
 * EdgeResolver signature alias (PR-4).
 *
 * Six resolvers (direct-call, property-access, jsx-element,
 * new-expression, polymorphic, catalog-fallback) all share this shape.
 * Declaring each resolver `: EdgeResolver<...>` makes drift a
 * typecheck error.
 */

import type { Catalog, ResolverVerdict } from '../../types.js';
import type ts from 'typescript';


export interface ResolverContext {
  readonly catalog: Catalog;
  readonly program: ts.Program;
  readonly typeChecker: ts.TypeChecker;
  readonly sourceFile: ts.SourceFile;
  readonly projectDirAbs: string;
}

export type EdgeResolver<N extends ts.Node = ts.Node> = (
  node: N,
  ctx: ResolverContext,
) => ResolverVerdict;
