// @fitness-ignore-file batch-operation-limits -- iterates bounded collection (catalog entries implementing a single interface/abstract class)
/**
 * Resolve method calls on interfaces / abstract classes to all
 * implementations.
 *
 * P2 ships a stub returning UNRESOLVED; P3 enriches via type-checker
 * inspection of the receiver's declared type.
 */

import ts from 'typescript';

import { DeclShape, functionLikeFromDeclaration } from '../edge-helpers/declaration-to-node.js';
import { findCatalogEntry } from '../edge-helpers/find-catalog-entry.js';

import type { EdgeResolver } from './types.js';

const UNRESOLVED = {
  to: [] as readonly string[],
  resolution: 'unknown' as const,
  confidence: 'low' as const,
};

const ACCEPT =
  DeclShape.MethodDeclaration |
  DeclShape.MethodSignature |
  DeclShape.FunctionDeclaration |
  DeclShape.ArrowFunction |
  DeclShape.FunctionExpression |
  DeclShape.Accessor |
  DeclShape.PropertyDeclaration |
  DeclShape.VariableInitializer |
  DeclShape.PropertyAssignmentInitializer;

export const resolvePolymorphicCall: EdgeResolver<ts.CallExpression> = (node, ctx) => {
  if (!ts.isPropertyAccessExpression(node.expression)) return UNRESOLVED;
  const methodName = node.expression.name.text;
  const receiverType = ctx.typeChecker.getTypeAtLocation(node.expression.expression);
  const candidates = collectMethodHashes(receiverType, methodName, ctx);
  if (candidates.length === 0) return UNRESOLVED;
  return {
    to: candidates,
    resolution: 'method-dispatch',
    confidence: candidates.length === 1 ? 'high' : 'medium',
  };
};

function collectMethodHashes(
  receiverType: ts.Type,
  methodName: string,
  ctx: Parameters<EdgeResolver<ts.CallExpression>>[1],
): string[] {
  const out: string[] = [];
  for (const sym of receiverType.getProperties()) {
    if (sym.getName() !== methodName) continue;
    appendHashesForSymbol(sym, methodName, ctx, out);
  }
  return out;
}

function appendHashesForSymbol(
  sym: ts.Symbol,
  methodName: string,
  ctx: Parameters<EdgeResolver<ts.CallExpression>>[1],
  out: string[],
): void {
  const decls = sym.getDeclarations() ?? [];
  for (const d of decls) {
    const declNode = functionLikeFromDeclaration(d, ACCEPT);
    if (!declNode) continue;
    const hash = findCatalogEntry(declNode, d.getSourceFile(), ctx.catalog, [methodName]);
    if (hash && !out.includes(hash)) out.push(hash);
  }
}
