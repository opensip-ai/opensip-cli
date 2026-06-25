/**
 * Resolve method calls on interfaces / abstract classes to all
 * implementations.
 */

import ts from 'typescript';

import { DeclShape, functionLikeFromDeclaration } from '../edge-helpers/declaration-to-node.js';
import { resolveDeclToHash } from '../edge-helpers/resolve-decl.js';

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
    const hash = resolveDeclToHash(declNode, d.getSourceFile(), [methodName], ctx);
    if (hash && !out.includes(hash)) out.push(hash);
  }
}
