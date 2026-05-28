// @fitness-ignore-file batch-operation-limits -- iterates bounded collection (import bindings + matching catalog entries per call site)
/**
 * Resolve direct identifier calls: `foo()`.
 *
 * Walks `getAliasedSymbol` to follow imports, then matches the
 * declaration against the catalog by bodyHash.
 */

import ts from 'typescript';

import { DeclShape, functionLikeFromDeclaration } from '../edge-helpers/declaration-to-node.js';
import { findCatalogEntry } from '../edge-helpers/find-catalog-entry.js';
import { unaliasSymbol } from '../edge-helpers/unalias-symbol.js';

import type { EdgeResolver } from './types.js';

const UNRESOLVED = {
  to: [] as readonly string[],
  resolution: 'unknown' as const,
  confidence: 'low' as const,
};

const ACCEPT =
  DeclShape.FunctionDeclaration |
  DeclShape.ArrowFunction |
  DeclShape.FunctionExpression |
  DeclShape.MethodDeclaration |
  DeclShape.ConstructorDeclaration |
  DeclShape.Accessor |
  DeclShape.VariableInitializer;

export const resolveDirectCall: EdgeResolver<ts.CallExpression> = (node, ctx) => {
  if (!ts.isIdentifier(node.expression)) return UNRESOLVED;
  const name = node.expression.text;
  const symbol = ctx.typeChecker.getSymbolAtLocation(node.expression);
  if (!symbol) return UNRESOLVED;

  const real = unaliasSymbol(symbol, ctx.typeChecker);
  const decls = real.getDeclarations() ?? [];
  for (const d of decls) {
    const sf = d.getSourceFile();
    const declNode = functionLikeFromDeclaration(d, ACCEPT);
    if (!declNode) continue;
    const hash = findCatalogEntry(declNode, sf, ctx.catalog, [name]);
    if (hash) {
      return { to: [hash], resolution: 'static', confidence: 'high' };
    }
  }
  return UNRESOLVED;
};
