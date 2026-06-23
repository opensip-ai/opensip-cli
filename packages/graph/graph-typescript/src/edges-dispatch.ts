import {
  appendEdge,
  ownerEdgeKey,
  resolveSpecifierToPackage,
  truncateForCallEdge,
} from '@opensip-cli/graph';
import ts from 'typescript';

import { DeclShape, functionLikeFromDeclaration } from './edge-helpers/declaration-to-node.js';
import { unaliasSymbol } from './edge-helpers/unalias-symbol.js';
import { resolveByCatalogFallback } from './edge-resolvers/catalog-fallback.js';
import { resolveDirectCall } from './edge-resolvers/direct-call.js';
import { resolveJsxElement } from './edge-resolvers/jsx-element.js';
import { resolveNewExpression } from './edge-resolvers/new-expression.js';
import { resolvePolymorphicCall } from './edge-resolvers/polymorphic.js';
import { resolvePropertyAccessCall } from './edge-resolvers/property-access.js';
import { calleeAnchorNode } from './edge-resolvers/syntactic.js';
import {
  isValueReference,
  resolveShorthandAssignment,
  resolveValueReference,
} from './edges-value-reference.js';

import type { ResolverContext } from './edge-resolvers/types.js';
import type {
  CallEdge,
  Catalog,
  EdgeSink,
  FunctionOccurrence,
  ResolverVerdict,
} from '@opensip-cli/graph';

export function tsPosition(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): {
  readonly line: number;
  readonly column: number;
  readonly text: string;
} {
  const anchor = calleeAnchorNode(node).getStart(sourceFile);
  const anchorLC = sourceFile.getLineAndCharacterOfPosition(anchor);
  return {
    line: anchorLC.line + 1,
    column: anchorLC.character,
    text: sourceFile.text.slice(node.getStart(sourceFile), node.getEnd()),
  };
}

export function pushCallEdge(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  verdict: ResolverVerdict,
  ownerKey: string,
  sink: EdgeSink,
): void {
  const { edgesByOwner: callsByHash, stats } = sink;
  stats.totalCallSites++;
  const pos = tsPosition(node, sourceFile);
  const edge: CallEdge = {
    to: verdict.to,
    line: pos.line,
    column: pos.column,
    resolution: verdict.resolution,
    confidence: verdict.confidence,
    text: truncateForCallEdge(pos.text),
    discarded: isReturnValueDiscarded(node),
  };
  appendEdge(callsByHash, ownerKey, edge);
  stats.apply(edge);
}

interface VerdictEntry {
  readonly predicate: (node: ts.Node) => boolean;
  readonly resolve: (node: ts.Node, ctx: ResolverContext) => ResolverVerdict | null;
}

function verdictEntry<N extends ts.Node>(
  predicate: (node: ts.Node) => node is N,
  resolve: (node: N, ctx: ResolverContext) => ResolverVerdict | null,
): VerdictEntry {
  return { predicate, resolve: (n, c) => resolve(n as N, c) };
}

const isJsxLikeOpening = (n: ts.Node): n is ts.JsxOpeningElement | ts.JsxSelfClosingElement =>
  ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n);

const isValueRefIdentifier = (n: ts.Node): n is ts.Identifier =>
  ts.isIdentifier(n) && isValueReference(n);

const VERDICT_TABLE: readonly VerdictEntry[] = [
  verdictEntry(ts.isCallExpression, (n, c) => dispatchCall(n, c)),
  verdictEntry(ts.isNewExpression, (n, c) => resolveNewExpression(n, c)),
  verdictEntry(isJsxLikeOpening, (n, c) => resolveJsxElement(n, c)),
  verdictEntry(isValueRefIdentifier, (n, c) => {
    const v = resolveValueReference(n, c);
    return v.to.length > 0 ? v : null;
  }),
  verdictEntry(ts.isShorthandPropertyAssignment, (n, c) => {
    const v = resolveShorthandAssignment(n, c);
    return v.to.length > 0 ? v : null;
  }),
];

export function computeVerdict(node: ts.Node, ctx: ResolverContext): ResolverVerdict | null {
  for (const entry of VERDICT_TABLE) {
    if (entry.predicate(node)) return entry.resolve(node, ctx);
  }
  return null;
}

function dispatchCall(node: ts.CallExpression, ctx: ResolverContext): ResolverVerdict {
  if (ts.isIdentifier(node.expression)) {
    const direct = resolveDirectCall(node, ctx);
    if (direct.to.length > 0) return direct;
    return fallbackWithBinding(node.expression, node.expression.text, ctx);
  }
  if (ts.isPropertyAccessExpression(node.expression)) {
    const direct = resolvePropertyAccessCall(node, ctx);
    if (direct.to.length > 0) return direct;
    const poly = resolvePolymorphicCall(node, ctx);
    if (poly.to.length > 0) return poly;
    return fallbackWithBinding(node.expression, node.expression.name.text, ctx);
  }
  return { to: [], resolution: 'unknown', confidence: 'low' };
}

const UNRESOLVED_VERDICT: ResolverVerdict = { to: [], resolution: 'unknown', confidence: 'low' };

function fallbackWithBinding(
  calleeExpr: ts.Expression,
  name: string,
  ctx: ResolverContext,
): ResolverVerdict {
  if (!hasProjectBinding(calleeExpr, name, ctx)) return UNRESOLVED_VERDICT;
  return resolveByCatalogFallback(name, ctx.catalog);
}

function hasProjectBinding(calleeExpr: ts.Expression, name: string, ctx: ResolverContext): boolean {
  if (symbolHasInProjectSourceDecl(calleeExpr, ctx)) return true;
  const spec = ctx.importSpecifiers.get(name);
  if (spec !== undefined) {
    if (spec.startsWith('.')) return true;
    return resolveSpecifierToPackage(spec, ctx.crossPackage.manifestIndex) !== undefined;
  }
  return false;
}

const CALLABLE_DECL =
  DeclShape.FunctionDeclaration |
  DeclShape.ArrowFunction |
  DeclShape.FunctionExpression |
  DeclShape.MethodDeclaration |
  DeclShape.ConstructorDeclaration |
  DeclShape.Accessor |
  DeclShape.VariableInitializer |
  DeclShape.PropertyAssignmentInitializer;

function symbolHasInProjectSourceDecl(calleeExpr: ts.Expression, ctx: ResolverContext): boolean {
  const symbol = ctx.typeChecker.getSymbolAtLocation(calleeExpr);
  if (!symbol) return false;
  const real = unaliasSymbol(symbol, ctx.typeChecker);
  for (const d of real.getDeclarations() ?? []) {
    if (
      !d.getSourceFile().isDeclarationFile &&
      functionLikeFromDeclaration(d, CALLABLE_DECL) !== null
    ) {
      return true;
    }
  }
  return false;
}

export function isReturnValueDiscarded(node: ts.Node): boolean {
  let parent: ts.Node | undefined = node.parent;
  while (parent) {
    if (ts.isParenthesizedExpression(parent) || ts.isAwaitExpression(parent)) {
      parent = parent.parent;
      continue;
    }
    return ts.isExpressionStatement(parent);
  }
  return false;
}

export function rebuildCatalog(
  catalog: Catalog,
  callsByHash: ReadonlyMap<string, readonly CallEdge[]>,
): Catalog {
  const functions: Record<string, readonly FunctionOccurrence[]> = Object.create(null) as Record<
    string,
    readonly FunctionOccurrence[]
  >;
  for (const name of Object.keys(catalog.functions)) {
    const occs: readonly FunctionOccurrence[] | undefined = catalog.functions[name];
    if (!occs) continue;
    functions[name] = occs.map((o) => ({
      ...o,
      calls: callsByHash.get(ownerEdgeKey(o.bodyHash, o.filePath)) ?? [],
    }));
  }
  return { ...catalog, functions };
}
