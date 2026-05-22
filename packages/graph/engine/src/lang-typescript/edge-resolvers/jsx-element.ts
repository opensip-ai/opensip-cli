/**
 * Resolve JSX elements: `<Foo />` / `<Foo>...</Foo>`.
 *
 * Component identifiers (PascalCase) resolve to their declarations
 * via the type checker. Lower-cased intrinsic elements (`<div />`)
 * are ignored — they have no catalog entry.
 *
 * Stage 2 entry point. P2 ships a stub returning UNRESOLVED;
 * full implementation lands in P3.
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

type JsxOpeningLike = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

export const resolveJsxElement: EdgeResolver<JsxOpeningLike> = (node, ctx) => {
  const tagName = node.tagName;
  // Intrinsic elements (`<div />`) are never tracked.
  if (ts.isIdentifier(tagName) && /^[a-z]/.test(tagName.text)) return UNRESOLVED;
  // Identifier or PropertyAccessExpression — both resolvable via the type checker.
  const symbol = ctx.typeChecker.getSymbolAtLocation(tagName);
  if (!symbol) return UNRESOLVED;
  const real = unaliasSymbol(symbol, ctx.typeChecker);
  const decls = real.getDeclarations() ?? [];

  const candidateName = ts.isIdentifier(tagName) ? tagName.text : tagName.getText();
  for (const d of decls) {
    const sf = d.getSourceFile();
    const declNode = functionLikeFromDeclaration(d);
    /* v8 ignore next */
    if (!declNode) continue;
    const hash = findCatalogEntry(declNode, sf, ctx.catalog, [candidateName]);
    if (hash) {
      return { to: [hash], resolution: 'jsx', confidence: 'high' };
    }
  }
  /* v8 ignore next */
  return UNRESOLVED;
};

function functionLikeFromDeclaration(d: ts.Declaration): ts.Node | null {
  if (
    ts.isFunctionDeclaration(d) ||
    ts.isArrowFunction(d) ||
    ts.isFunctionExpression(d)
  ) {
    return d;
  }
  if (ts.isVariableDeclaration(d) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
      return d.initializer;
    }
  /* v8 ignore next */
  return null;
}
