// @fitness-ignore-file batch-operation-limits -- iterates bounded collection (catalog entries for a single JSX element resolution)
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
  DeclShape.VariableInitializer;

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
    const declNode = functionLikeFromDeclaration(d, ACCEPT);
    if (!declNode) continue;
    const hash = findCatalogEntry(declNode, sf, ctx.catalog, [candidateName]);
    if (hash) {
      return { to: [hash], resolution: 'jsx', confidence: 'high' };
    }
  }
  return UNRESOLVED;
};
