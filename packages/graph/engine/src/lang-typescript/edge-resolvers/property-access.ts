/**
 * Resolve `obj.method()` / `Pkg.fn()` calls.
 *
 * P2 ships a basic identifier-symbol-based resolution; P3 enriches
 * with polymorphic dispatch on interface / abstract method calls.
 */

import ts from 'typescript';

import { findCatalogEntry } from '../edge-helpers/find-catalog-entry.js';
import { unaliasSymbol } from '../edge-helpers/unalias-symbol.js';

import type { EdgeResolver } from './types.js';

const UNRESOLVED = {
  to: [] as readonly string[],
  resolution: 'unknown' as const,
  confidence: 'low' as const,
};

export const resolvePropertyAccessCall: EdgeResolver<ts.CallExpression> = (node, ctx) => {
  if (!ts.isPropertyAccessExpression(node.expression)) return UNRESOLVED;
  const propName = node.expression.name.text;
  const symbol = ctx.typeChecker.getSymbolAtLocation(node.expression);
  if (!symbol) return UNRESOLVED;

  const real = unaliasSymbol(symbol, ctx.typeChecker);
  const decls = real.getDeclarations() ?? [];
  for (const d of decls) {
    const sf = d.getSourceFile();
    const declNode = functionLikeFromDeclaration(d);
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

function functionLikeFromDeclaration(d: ts.Declaration): ts.Node | null {
  if (
    ts.isFunctionDeclaration(d) ||
    ts.isArrowFunction(d) ||
    ts.isFunctionExpression(d) ||
    ts.isMethodDeclaration(d) ||
    ts.isConstructorDeclaration(d) ||
    ts.isGetAccessor(d) ||
    ts.isSetAccessor(d)
  ) {
    return d;
  }
  if (ts.isPropertyAssignment(d) && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
      return d.initializer;
    }
  if (ts.isVariableDeclaration(d) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
      return d.initializer;
    }
  return null;
}
