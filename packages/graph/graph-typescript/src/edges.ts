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
import {
  appendEdge,
  createMutableStats,
  pushCreationEdge as pushSharedCreationEdge,
  truncateForCallEdge,
} from '@opensip-tools/graph';
import ts from 'typescript';

import { resolveByCatalogFallback } from './edge-resolvers/catalog-fallback.js';
import { resolveDirectCall } from './edge-resolvers/direct-call.js';
import { resolveJsxElement } from './edge-resolvers/jsx-element.js';
import { resolveNewExpression } from './edge-resolvers/new-expression.js';
import { resolvePolymorphicCall } from './edge-resolvers/polymorphic.js';
import { resolvePropertyAccessCall } from './edge-resolvers/property-access.js';
import {
  isValueReference,
  resolveShorthandAssignment,
  resolveValueReference,
} from './edges-value-reference.js';
import { hashFunctionBody, hashSyntheticBody } from './inventory-helpers/hash-body.js';
import { synthesizeModuleInitName } from './inventory-helpers/synthesize-name.js';
import { isInlineCallable } from './walk.js';

import type { ResolverContext } from './edge-resolvers/types.js';
import type { CallSiteRecord } from './walk.js';
import type {
  CallEdge,
  Catalog,
  FunctionOccurrence,
  ResolutionStats,
  ResolverVerdict,
  MutableStats,
} from '@opensip-tools/graph';

function tsPosition(node: ts.Node, sourceFile: ts.SourceFile): {
  readonly line: number;
  readonly column: number;
  readonly text: string;
} {
  const start = node.getStart(sourceFile);
  const startLC = sourceFile.getLineAndCharacterOfPosition(start);
  return {
    line: startLC.line + 1,
    column: startLC.character,
    text: sourceFile.text.slice(start, node.getEnd()),
  };
}

export interface EdgeResolutionInput {
  readonly catalog: Catalog;
  readonly program: ts.Program;
  readonly projectDirAbs: string;
}

export interface EdgeResolutionOutput {
  readonly catalog: Catalog;
  readonly resolutionStats: ResolutionStats;
}

export interface EdgeResolutionFromRecordsInput {
  readonly catalog: Catalog;
  readonly program: ts.Program;
  readonly projectDirAbs: string;
  readonly callSites: readonly CallSiteRecord[];
}

/**
 * Phase 4 entry point: resolve a pre-collected list of call-site
 * records produced by `walkProgram`. Skips the AST descent that the
 * legacy `resolveEdges` did. Used by the orchestrator. The legacy
 * `resolveEdges` is retained for tests and external callers that
 * want a one-shot Stage 1+2 from a catalog.
 */
export function resolveEdgesFromRecords(
  input: EdgeResolutionFromRecordsInput,
): EdgeResolutionOutput {
  logger.info({ evt: 'graph.edges.start', module: 'graph:edges' });
  const checker = input.program.getTypeChecker();
  const callsByHash = new Map<string, CallEdge[]>();
  const stats = createMutableStats();

  for (const r of input.callSites) {
    if (r.kind === 'creation') {
      if (r.childHash === undefined) continue;
      pushSharedCreationEdge(
        r.node,
        r.sourceFile,
        r.ownerHash,
        r.childHash,
        callsByHash,
        stats,
        tsPosition,
      );
      continue;
    }
    const ctx: ResolverContext = {
      catalog: input.catalog,
      program: input.program,
      typeChecker: checker,
      sourceFile: r.sourceFile,
      projectDirAbs: input.projectDirAbs,
    };
    const verdict = computeVerdict(r.node, ctx);
    if (verdict === null) continue;
    pushCallEdge(r.node, r.sourceFile, verdict, r.ownerHash, callsByHash, stats);
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

/**
 * Append an ordinary call/new/jsx/value-reference edge from a resolver
 * verdict. Bumps `totalCallSites` directly (every call expression is
 * a site, even unresolved-by-shape ones); delegates per-confidence
 * classification to `stats.apply`.
 */
function pushCallEdge(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  verdict: ResolverVerdict,
  ownerHash: string,
  callsByHash: Map<string, CallEdge[]>,
  stats: MutableStats,
): void {
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
  appendEdge(callsByHash, ownerHash, edge);
  stats.apply(edge);
}

/**
 * Legacy one-shot Stage 1+2 entry kept for tests and external callers
 * that don't go through the orchestrator. Descends the AST to produce
 * a flat `CallSiteRecord[]`, then delegates to
 * `resolveEdgesFromRecords` — the same path the orchestrator uses.
 *
 * Production code should call `resolveEdgesFromRecords` directly with
 * the records produced by `walkProgram`.
 */
export function resolveEdges(input: EdgeResolutionInput): EdgeResolutionOutput {
  const fnByHash = buildHashIndex(input.catalog);
  const callSites: CallSiteRecord[] = [];

  for (const sf of input.program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const filePathProjectRel = relative(input.projectDirAbs, sf.fileName).split(sep).join('/');
    if (!hasFileInCatalog(input.catalog, filePathProjectRel)) continue;
    collectCallSites(sf, filePathProjectRel, input.catalog, fnByHash, callSites);
  }

  return resolveEdgesFromRecords({
    catalog: input.catalog,
    program: input.program,
    projectDirAbs: input.projectDirAbs,
    callSites,
  });
}

/**
 * Walk a single file's AST in the same order as `walkProgram`, pairing
 * every resolver-candidate site (calls, new-expressions, JSX, value
 * references, shorthand) and every inline-callable creation with its
 * owning function's bodyHash. Pushes records onto the shared list so
 * a downstream `resolveEdgesFromRecords` can drive resolver dispatch
 * without re-walking.
 */
function collectCallSites(
  sourceFile: ts.SourceFile,
  filePathProjectRel: string,
  catalog: Catalog,
  fnByHash: ReadonlyMap<string, FunctionOccurrence>,
  out: CallSiteRecord[],
): void {
  const moduleInitHash = lookupModuleInitHash(sourceFile, filePathProjectRel, catalog);

  function walk(node: ts.Node, ownerHash: string | null): void {
    const hash = isFunctionLike(node) ? hashOf(node, sourceFile, fnByHash) : null;
    const childOwner = hash ?? ownerHash;

    if (ownerHash !== null && isResolverCandidateNode(node)) {
      out.push({ node, sourceFile, ownerHash, kind: 'call' });
    }

    if (
      hash !== null &&
      ownerHash !== null &&
      hash !== ownerHash &&
      isInlineCallable(node)
    ) {
      out.push({
        node,
        sourceFile,
        ownerHash,
        kind: 'creation',
        childHash: hash,
      });
    }

    ts.forEachChild(node, (c) => { walk(c, childOwner); });
  }

  ts.forEachChild(sourceFile, (c) => { walk(c, moduleInitHash); });
}

/**
 * Pre-filter mirroring `computeVerdict`'s acceptance set. Pushing
 * non-candidates would still produce no edges (the resolver returns
 * null), but skipping them up front keeps `resolveEdgesFromRecords`
 * out of pointless dispatcher hops.
 */
function isResolverCandidateNode(node: ts.Node): boolean {
  if (ts.isCallExpression(node)) return true;
  if (ts.isNewExpression(node)) return true;
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) return true;
  if (ts.isShorthandPropertyAssignment(node)) return true;
  if (ts.isIdentifier(node) && isValueReference(node)) return true;
  return false;
}

/**
 * Resolver dispatch table — predicate-keyed pairs covering the five
 * resolver-target shapes. Entries that hand off to a single resolver
 * pass its verdict through verbatim. The identifier/shorthand entries
 * additionally suppress empty (`to: []`) verdicts so we don't emit a
 * useless edge for unresolved value references — same semantics the
 * legacy if-ladder had.
 *
 * Each entry is built via {@link verdictEntry}, which carries the
 * predicate's narrowed type into the resolve callback. The cast
 * (`node as N`) is sound by construction — the dispatcher only fires
 * `resolve` when `predicate(node)` returned true — but TS's flow
 * analysis can't see through a separate predicate/callback pairing
 * inside a literal, so the cast lives once inside the helper rather
 * than at every entry. Audit 2026-05-23 M-2.
 */
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

const isJsxLikeOpening = (
  n: ts.Node,
): n is ts.JsxOpeningElement | ts.JsxSelfClosingElement =>
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

/** Returns null if `node` is not a call/new/jsx/value-reference site. */
function computeVerdict(node: ts.Node, ctx: ResolverContext): ResolverVerdict | null {
  for (const entry of VERDICT_TABLE) {
    if (entry.predicate(node)) return entry.resolve(node, ctx);
  }
  return null;
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

/**
 * The call's return value is discarded when the call expression is the
 * entire expression of an ExpressionStatement (`foo();`). Anything else
 * — assignment RHS, return value, argument, conditional, member chain
 * — consumes the return value.
 *
 * `await foo()` and `(foo())` wrappers are unwrapped so the underlying
 * intent is preserved.
 */
function isReturnValueDiscarded(node: ts.Node): boolean {
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
    /* v8 ignore next */
    if (!occs) continue;
    for (const o of occs) if (o.filePath === filePath) return true;
  }
  /* v8 ignore next */
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
