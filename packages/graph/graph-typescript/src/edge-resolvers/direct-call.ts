/**
 * Resolve direct identifier calls: `foo()`.
 *
 * Walks `getAliasedSymbol` to follow imports, then matches the
 * declaration against the catalog by bodyHash.
 */

import ts from 'typescript';

import { DeclShape, functionLikeFromDeclaration } from '../edge-helpers/declaration-to-node.js';
import { resolveDeclToHash } from '../edge-helpers/resolve-decl.js';
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
  const bindingName = node.expression.text;
  const symbol = ctx.typeChecker.getSymbolAtLocation(node.expression);
  if (!symbol) return UNRESOLVED;

  const real = unaliasSymbol(symbol, ctx.typeChecker, ctx.recordResolutionDegradation);
  const decls = real.getDeclarations() ?? [];
  for (const d of decls) {
    const sf = d.getSourceFile();
    const declNode = functionLikeFromDeclaration(d, ACCEPT);
    if (!declNode) continue;
    const hash = resolveDeclToHash(declNode, sf, [semanticTargetName(real, d)], ctx, [bindingName]);
    if (hash) {
      return { to: [hash], resolution: 'static', confidence: 'high' };
    }
  }
  return UNRESOLVED;
};

/**
 * The catalog target name belongs to the unaliased SOURCE declaration, while
 * the caller-local spelling is only an import binding. TypeScript names a
 * default-export symbol `default`; translate that one semantic sentinel to the
 * inventory's source identity for function declarations.
 */
function semanticTargetName(symbol: ts.Symbol, declaration: ts.Declaration): string {
  const name = symbol.getName();
  if (name !== 'default' || !ts.isFunctionDeclaration(declaration)) return name;
  return declaration.name?.text ?? '<default>';
}
