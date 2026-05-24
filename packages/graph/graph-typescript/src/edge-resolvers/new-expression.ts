/**
 * Resolve `new MyClass(...)` to the constructor's catalog entry.
 *
 * The bodyHash of the constructor is what stage 1 wrote when it
 * visited the `constructor() {}` member; here we find that
 * declaration via the symbol of the class identifier.
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

export const resolveNewExpression: EdgeResolver<ts.NewExpression> = (node, ctx) => {
  const expr = node.expression;
  /* v8 ignore next */
  if (!ts.isIdentifier(expr) && !ts.isPropertyAccessExpression(expr)) return UNRESOLVED;
  const symbol = ctx.typeChecker.getSymbolAtLocation(expr);
  /* v8 ignore next */
  if (!symbol) return UNRESOLVED;

  const real = unaliasSymbol(symbol, ctx.typeChecker);
  const decls = real.getDeclarations() ?? [];
  for (const d of decls) {
    /* v8 ignore next */
    if (!ts.isClassDeclaration(d) && !ts.isClassExpression(d)) continue;
    const ctor = findConstructor(d);
    /* v8 ignore next */
    if (!ctor) continue;
    const className = d.name?.text ?? null;
    const sf = d.getSourceFile();
    /* v8 ignore next */
    const candidateNames = className ? [className] : [];
    const hash = findCatalogEntry(ctor, sf, ctx.catalog, candidateNames);
    if (hash) {
      return { to: [hash], resolution: 'constructor', confidence: 'high' };
    }
  }
  /* v8 ignore next */
  return UNRESOLVED;
};

function findConstructor(cls: ts.ClassLikeDeclaration): ts.ConstructorDeclaration | null {
  for (const m of cls.members) {
    if (ts.isConstructorDeclaration(m)) return m;
  }
  /* v8 ignore next */
  return null;
}
