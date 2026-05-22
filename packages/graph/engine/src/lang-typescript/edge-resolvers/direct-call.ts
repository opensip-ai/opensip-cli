/**
 * Resolve direct identifier calls: `foo()`.
 *
 * Walks `getAliasedSymbol` to follow imports, then matches the
 * declaration against the catalog by bodyHash.
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

export const resolveDirectCall: EdgeResolver<ts.CallExpression> = (node, ctx) => {
  if (!ts.isIdentifier(node.expression)) return UNRESOLVED;
  const name = node.expression.text;
  const symbol = ctx.typeChecker.getSymbolAtLocation(node.expression);
  if (!symbol) return UNRESOLVED;

  const real = unaliasSymbol(symbol, ctx.typeChecker);
  const decls = real.getDeclarations() ?? [];
  for (const d of decls) {
    const sf = d.getSourceFile();
    const declNode = functionLikeFromDeclaration(d);
    if (!declNode) continue;
    const hash = findCatalogEntry(declNode, sf, ctx.catalog, [name]);
    if (hash) {
      return { to: [hash], resolution: 'static', confidence: 'high' };
    }
  }
  /* v8 ignore next */
  return UNRESOLVED;
};

/* v8 ignore start */
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
  if (ts.isVariableDeclaration(d) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
      return d.initializer;
    }
  return null;
}
/* v8 ignore stop */
