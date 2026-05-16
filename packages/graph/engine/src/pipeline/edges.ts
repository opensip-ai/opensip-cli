/**
 * Stage 2 — Edge resolution.
 *
 * Walks every file's AST: for each function-shaped node we hash and
 * find the matching catalog entry. We then collect call sites in
 * that function's body (skipping nested functions, which own their
 * own bodies). For each call site, dispatch to the appropriate
 * resolver and append the CallEdge to the catalog entry's calls[].
 *
 * Top-level statements (statements not inside any function-shaped
 * node) own a synthetic module-init occurrence (synthesized in stage
 * 1).
 */

import { relative, sep } from 'node:path';

import { logger } from '@opensip-tools/core';
import ts from 'typescript';

import { resolveByCatalogFallback } from './edge-resolvers/catalog-fallback.js';
import { resolveDirectCall } from './edge-resolvers/direct-call.js';
import { resolveJsxElement } from './edge-resolvers/jsx-element.js';
import { resolveNewExpression } from './edge-resolvers/new-expression.js';
import { resolvePolymorphicCall } from './edge-resolvers/polymorphic.js';
import { resolvePropertyAccessCall } from './edge-resolvers/property-access.js';
import { hashFunctionBody, hashSyntheticBody } from './inventory-helpers/hash-body.js';
import { synthesizeModuleInitName } from './inventory-helpers/synthesize-name.js';

import type {
  CallEdge,
  Catalog,
  FunctionOccurrence,
  ResolutionStats,
  ResolverVerdict,
} from '../types.js';
import type { ResolverContext } from './edge-resolvers/types.js';

export interface EdgeResolutionInput {
  readonly catalog: Catalog;
  readonly program: ts.Program;
  readonly projectDirAbs: string;
}

export interface EdgeResolutionOutput {
  readonly catalog: Catalog;
  readonly resolutionStats: ResolutionStats;
}

export function resolveEdges(input: EdgeResolutionInput): EdgeResolutionOutput {
  logger.info({ evt: 'graph.edges.start', module: 'graph:edges' });
  const checker = input.program.getTypeChecker();

  // We mutate the FunctionOccurrence.calls slot by replacing each
  // entry; the catalog itself is rebuilt at the end so the returned
  // shape is fresh.
  const fnByHash = buildHashIndex(input.catalog);
  const callsByHash = new Map<string, CallEdge[]>();

  const stats = { totalCallSites: 0, resolvedHigh: 0, resolvedMedium: 0, resolvedLow: 0, unresolved: 0 };

  for (const sf of input.program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const filePathProjectRel = relative(input.projectDirAbs, sf.fileName).split(sep).join('/');
    if (!hasFileInCatalog(input.catalog, filePathProjectRel)) continue;
    walkFileForEdges({
      sourceFile: sf,
      filePathProjectRel,
      catalog: input.catalog,
      fnByHash,
      callsByHash,
      stats,
      ctx: {
        catalog: input.catalog,
        program: input.program,
        typeChecker: checker,
        sourceFile: sf,
        projectDirAbs: input.projectDirAbs,
      },
    });
  }

  const newCatalog = rebuildCatalog(input.catalog, callsByHash);

  logger.info({
    evt: 'graph.edges.complete',
    module: 'graph:edges',
    totalCallSites: stats.totalCallSites,
    resolvedHigh: stats.resolvedHigh,
    resolvedMedium: stats.resolvedMedium,
    resolvedLow: stats.resolvedLow,
    unresolved: stats.unresolved,
  });

  return { catalog: newCatalog, resolutionStats: stats };
}

interface WalkArgs {
  readonly sourceFile: ts.SourceFile;
  readonly filePathProjectRel: string;
  readonly catalog: Catalog;
  readonly fnByHash: ReadonlyMap<string, FunctionOccurrence>;
  readonly callsByHash: Map<string, CallEdge[]>;
  readonly stats: { totalCallSites: number; resolvedHigh: number; resolvedMedium: number; resolvedLow: number; unresolved: number };
  readonly ctx: ResolverContext;
}

function walkFileForEdges(args: WalkArgs): void {
  // Module-init owns top-level call sites.
  const moduleInitHash = lookupModuleInitHash(args.sourceFile, args.filePathProjectRel, args.catalog);

  function walk(node: ts.Node, ownerHash: string | null): void {
    // If we're entering a function-shaped node, look up its hash; the
    // calls inside this node belong to that owner.
    const hash = isFunctionLike(node) ? hashOf(node, args.sourceFile, args.fnByHash) : null;
    const childOwner = hash ?? ownerHash;

    // Collect call sites whose ownership belongs to `ownerHash` only
    // when this very node is the call expression / new / jsx.
    if (ownerHash !== null) {
      maybeCollectCallSite(node, ownerHash, args);
    }

    ts.forEachChild(node, (c) => { walk(c, childOwner); });
  }

  // Descend from the source file. Module-init owns everything that's
  // not inside a function-shaped node.
  ts.forEachChild(args.sourceFile, (c) => { walk(c, moduleInitHash); });
}

function maybeCollectCallSite(node: ts.Node, ownerHash: string, args: WalkArgs): void {
  if (ts.isCallExpression(node)) {
    args.stats.totalCallSites++;
    const verdict = dispatchCall(node, args.ctx);
    pushEdge(node, verdict, ownerHash, args);
  } else if (ts.isNewExpression(node)) {
    args.stats.totalCallSites++;
    const verdict = resolveNewExpression(node, args.ctx);
    pushEdge(node, verdict, ownerHash, args);
  } else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
    args.stats.totalCallSites++;
    const verdict = resolveJsxElement(node, args.ctx);
    pushEdge(node, verdict, ownerHash, args);
  }
}

function dispatchCall(
  node: ts.CallExpression,
  ctx: ResolverContext,
): ResolverVerdict {
  // Direct identifier call: foo()
  if (ts.isIdentifier(node.expression)) {
    const direct = resolveDirectCall(node, ctx);
    if (direct.to.length > 0) return direct;
    return resolveByCatalogFallback(node.expression.text, ctx.catalog);
  }
  // Property access call: obj.method()
  if (ts.isPropertyAccessExpression(node.expression)) {
    const direct = resolvePropertyAccessCall(node, ctx);
    if (direct.to.length > 0) return direct;
    const poly = resolvePolymorphicCall(node, ctx);
    if (poly.to.length > 0) return poly;
    // Fallback: look up by the rightmost simple name.
    return resolveByCatalogFallback(node.expression.name.text, ctx.catalog);
  }
  return { to: [], resolution: 'unknown', confidence: 'low' };
}

function pushEdge(
  node: ts.Node,
  verdict: ResolverVerdict,
  ownerHash: string,
  args: WalkArgs,
): void {
  const start = node.getStart(args.sourceFile);
  const startLC = args.sourceFile.getLineAndCharacterOfPosition(start);
  const text = node.getText(args.sourceFile);
  const edge: CallEdge = {
    to: verdict.to,
    line: startLC.line + 1,
    column: startLC.character,
    resolution: verdict.resolution,
    confidence: verdict.confidence,
    text: text.length > 80 ? `${text.slice(0, 77)}...` : text,
  };
  const list = args.callsByHash.get(ownerHash);
  if (list) {
    list.push(edge);
  } else {
    args.callsByHash.set(ownerHash, [edge]);
  }
  if (verdict.to.length === 0) args.stats.unresolved++;
  else if (verdict.confidence === 'high') args.stats.resolvedHigh++;
  else if (verdict.confidence === 'medium') args.stats.resolvedMedium++;
  else args.stats.resolvedLow++;
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  );
}

function hashOf(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  fnByHash: ReadonlyMap<string, FunctionOccurrence>,
): string | null {
  const h = hashFunctionBody(node, sourceFile);
  return fnByHash.has(h) ? h : null;
}

function buildHashIndex(catalog: Catalog): Map<string, FunctionOccurrence> {
  const map = new Map<string, FunctionOccurrence>();
  for (const name of Object.keys(catalog.functions)) {
    const occs: readonly FunctionOccurrence[] | undefined = catalog.functions[name];
    if (!occs) continue;
    for (const o of occs) {
      // First wins; per-file collisions are intentional duplicates.
      if (!map.has(o.bodyHash)) map.set(o.bodyHash, o);
    }
  }
  return map;
}

function lookupModuleInitHash(
  sourceFile: ts.SourceFile,
  filePathProjectRel: string,
  catalog: Catalog,
): string | null {
  const name = synthesizeModuleInitName(filePathProjectRel);
  if (!Object.hasOwn(catalog.functions, name)) return null;
  const occs: readonly FunctionOccurrence[] | undefined = catalog.functions[name];
  if (!occs || occs.length === 0) return null;
  // Validate by hash so cross-file synonyms can't collide accidentally.
  const topLevelText = sourceFile.statements.map((s) => s.getText(sourceFile)).join('\n');
  const expected = hashSyntheticBody(`${filePathProjectRel}\n${topLevelText}`);
  const occ = occs.find((o) => o.bodyHash === expected) ?? occs[0];
  return occ?.bodyHash ?? null;
}

function hasFileInCatalog(catalog: Catalog, filePath: string): boolean {
  for (const name of Object.keys(catalog.functions)) {
    const occs: readonly FunctionOccurrence[] | undefined = catalog.functions[name];
    if (!occs) continue;
    for (const o of occs) if (o.filePath === filePath) return true;
  }
  return false;
}

function rebuildCatalog(
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
      calls: callsByHash.get(o.bodyHash) ?? [],
    }));
  }
  return { ...catalog, functions };
}
