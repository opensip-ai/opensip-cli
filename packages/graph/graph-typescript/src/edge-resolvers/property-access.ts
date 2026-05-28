// @fitness-ignore-file batch-operation-limits -- iterates bounded collection (catalog entries for a single property-access resolution)
/**
 * Resolve `obj.method()` / `Pkg.fn()` calls.
 *
 * P2 ships a basic identifier-symbol-based resolution; P3 enriches
 * with polymorphic dispatch on interface / abstract method calls.
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
  DeclShape.VariableInitializer |
  DeclShape.PropertyAssignmentInitializer;

export const resolvePropertyAccessCall: EdgeResolver<ts.CallExpression> = (node, ctx) => {
  if (!ts.isPropertyAccessExpression(node.expression)) return UNRESOLVED;
  const propName = node.expression.name.text;
  const symbol = ctx.typeChecker.getSymbolAtLocation(node.expression);
  if (!symbol) return UNRESOLVED;

  const real = unaliasSymbol(symbol, ctx.typeChecker);
  const decls = real.getDeclarations() ?? [];
  for (const d of decls) {
    const sf = d.getSourceFile();
    const declNode = functionLikeFromDeclaration(d, ACCEPT);
    if (!declNode) continue;
    const hash = findCatalogEntry(declNode, sf, ctx.catalog, [propName]);
    if (hash) {
      return {
        to: [hash],
        resolution: 'method-dispatch',
        confidence: 'high',
      };
    }
  }
  return UNRESOLVED;
};
