/**
 * Resolve `obj.method()` / `Pkg.fn()` calls.
 *
 * Direct symbol resolution handles concrete declarations; the polymorphic
 * resolver handles interface / abstract method dispatch.
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
  DeclShape.VariableInitializer |
  DeclShape.PropertyAssignmentInitializer;

export const resolvePropertyAccessCall: EdgeResolver<ts.CallExpression> = (node, ctx) => {
  if (!ts.isPropertyAccessExpression(node.expression)) return UNRESOLVED;
  const propName = node.expression.name.text;
  const symbol = ctx.typeChecker.getSymbolAtLocation(node.expression);
  if (!symbol) return UNRESOLVED;

  // Receiver binding name for `ns.fn()` / `Pkg.fn()` — the local name that
  // carries the workspace import specifier (a namespace/default import). Used by
  // the cross-package boundary path so `ns.fn()` binds to `ns`'s package, while
  // the EXPORTED callee name to look up stays `fn` (`propName`).
  //
  // `propName` (the METHOD name) must NOT be a binding: a method is not an import
  // binding, and including it defeated the binding-required phantom guard —
  // `new Widget().serialize()` misresolved to a same-named free function
  // `serialize` imported from another package. With no receiver identifier
  // (`new X().m()`, `getX().m()`) there is no cross-package binding, so the
  // boundary path declines and falls back to the type-anchored dts-decl pin.
  const receiver = node.expression.expression;
  const bindingNames = ts.isIdentifier(receiver) ? [receiver.text] : [];

  const real = unaliasSymbol(symbol, ctx.typeChecker, ctx.recordResolutionDegradation);
  const decls = real.getDeclarations() ?? [];
  for (const d of decls) {
    const sf = d.getSourceFile();
    const declNode = functionLikeFromDeclaration(d, ACCEPT);
    if (!declNode) continue;
    const hash = resolveDeclToHash(declNode, sf, [propName], ctx, bindingNames);
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
