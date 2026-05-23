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

import {
  appendEdge,
  createMutableStats,
  pushCreationEdge as pushSharedCreationEdge,
  type MutableStats,
} from '../lang-adapter/edge-helpers.js';

import { findCatalogEntry } from './edge-helpers/find-catalog-entry.js';
import { resolveByCatalogFallback } from './edge-resolvers/catalog-fallback.js';
import { resolveDirectCall } from './edge-resolvers/direct-call.js';
import { resolveJsxElement } from './edge-resolvers/jsx-element.js';
import { resolveNewExpression } from './edge-resolvers/new-expression.js';
import { resolvePolymorphicCall } from './edge-resolvers/polymorphic.js';
import { resolvePropertyAccessCall } from './edge-resolvers/property-access.js';
import { hashFunctionBody, hashSyntheticBody } from './inventory-helpers/hash-body.js';
import { synthesizeModuleInitName } from './inventory-helpers/synthesize-name.js';
import { isInlineCallable } from './walk.js';

import type {
  CallEdge,
  Catalog,
  FunctionOccurrence,
  ResolutionStats,
  ResolverVerdict,
} from '../types.js';
import type { ResolverContext } from './edge-resolvers/types.js';
import type { CallSiteRecord } from './walk.js';

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
    text: pos.text.length > 80 ? `${pos.text.slice(0, 77)}...` : pos.text,
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
 */
interface VerdictEntry {
  readonly predicate: (node: ts.Node) => boolean;
  readonly resolve: (node: ts.Node, ctx: ResolverContext) => ResolverVerdict | null;
}

const VERDICT_TABLE: readonly VerdictEntry[] = [
  { predicate: ts.isCallExpression, resolve: (n, c) => dispatchCall(n as ts.CallExpression, c) },
  { predicate: ts.isNewExpression, resolve: (n, c) => resolveNewExpression(n as ts.NewExpression, c) },
  {
    predicate: (n) => ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n),
    resolve: (n, c) => resolveJsxElement(n as ts.JsxOpeningElement | ts.JsxSelfClosingElement, c),
  },
  {
    predicate: (n) => ts.isIdentifier(n) && isValueReference(n),
    resolve: (n, c) => {
      const v = resolveValueReference(n as ts.Identifier, c);
      return v.to.length > 0 ? v : null;
    },
  },
  {
    predicate: ts.isShorthandPropertyAssignment,
    resolve: (n, c) => {
      const v = resolveShorthandAssignment(n as ts.ShorthandPropertyAssignment, c);
      return v.to.length > 0 ? v : null;
    },
  },
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

/**
 * Identifier appears in a value position — not as a call target, not as
 * a binding name, not as the property name of a property access. We
 * want to capture handoff cases: function passed as argument, shorthand
 * property assignment, default value, return value.
 */
function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  return !isStructuralName(node, parent) && !isCallSiteTarget(node, parent);
}

/**
 * Identifier is the *name* of some declaration / property, or part of
 * a type / import / export. Not a value use.
 */
function isStructuralName(node: ts.Identifier, parent: ts.Node): boolean {
  return isParentNamePosition(node, parent) || isUnconditionallyStructural(parent);
}

function isParentNamePosition(node: ts.Identifier, parent: ts.Node): boolean {
  // Each entry: matcher for the parent kind + the property whose value
  // we compare with `node` to decide whether the identifier is the
  // structural name slot.
  const slot = readNamedSlot(parent);
  return slot === node;
}

function readNamedSlot(parent: ts.Node): ts.Node | undefined {
  if (ts.isVariableDeclaration(parent)) return parent.name;
  if (ts.isParameter(parent)) return parent.name;
  if (ts.isFunctionDeclaration(parent)) return parent.name;
  if (ts.isClassDeclaration(parent)) return parent.name;
  if (ts.isMethodDeclaration(parent)) return parent.name;
  if (ts.isPropertyDeclaration(parent)) return parent.name;
  if (ts.isPropertyAssignment(parent)) return parent.name;
  if (ts.isPropertyAccessExpression(parent)) return parent.name;
  if (ts.isLabeledStatement(parent)) return parent.label;
  if (ts.isBindingElement(parent)) return parent.name;
  return undefined;
}

function isUnconditionallyStructural(parent: ts.Node): boolean {
  return (
    ts.isQualifiedName(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isTypeReferenceNode(parent)
  );
}

/** Identifier is the call target / new target / JSX tag — we handle those elsewhere. */
function isCallSiteTarget(node: ts.Identifier, parent: ts.Node): boolean {
  if (ts.isCallExpression(parent) && parent.expression === node) return true;
  if (ts.isNewExpression(parent) && parent.expression === node) return true;
  if (ts.isJsxOpeningElement(parent) && parent.tagName === node) return true;
  if (ts.isJsxSelfClosingElement(parent) && parent.tagName === node) return true;
  return false;
}

function resolveValueReference(
  node: ts.Identifier,
  ctx: ResolverContext,
): ResolverVerdict {
  const symbol = ctx.typeChecker.getSymbolAtLocation(node);
  return resolveSymbolToHash(symbol, node.text, ctx);
}

function resolveShorthandAssignment(
  node: ts.ShorthandPropertyAssignment,
  ctx: ResolverContext,
): ResolverVerdict {
  const symbol = ctx.typeChecker.getShorthandAssignmentValueSymbol(node);
  return resolveSymbolToHash(symbol, node.name.text, ctx);
}

/**
 * Resolve any symbol whose declarations might be a function-shaped
 * node to its catalog bodyHash. Used by value-reference and shorthand
 * resolvers — they share this lookup logic.
 */
function resolveSymbolToHash(
  symbol: ts.Symbol | undefined,
  fallbackName: string,
  ctx: ResolverContext,
): ResolverVerdict {
  if (!symbol) return { to: [], resolution: 'unknown', confidence: 'low' };
  for (const d of symbol.getDeclarations() ?? []) {
    const hash = hashFromDeclaration(d, fallbackName, ctx);
    if (hash) return { to: [hash], resolution: 'static', confidence: 'medium' };
  }
  return { to: [], resolution: 'unknown', confidence: 'low' };
}

function hashFromDeclaration(
  d: ts.Declaration,
  fallbackName: string,
  ctx: ResolverContext,
): string | null {
  if (ts.isClassDeclaration(d) || ts.isClassExpression(d)) {
    const ctor = findClassConstructor(d);
    if (!ctor) return null;
    const className = d.name?.text;
    return findCatalogEntry(ctor, d.getSourceFile(), ctx.catalog, className ? [className] : []);
  }
  if (
    ts.isFunctionDeclaration(d) ||
    ts.isArrowFunction(d) ||
    ts.isFunctionExpression(d) ||
    ts.isMethodDeclaration(d)
  ) {
    return findCatalogEntry(d, d.getSourceFile(), ctx.catalog, [fallbackName]);
  }
  if (ts.isVariableDeclaration(d) && d.initializer) {
    const init = d.initializer;
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
      return findCatalogEntry(init, d.getSourceFile(), ctx.catalog, [fallbackName]);
    }
  }
  return null;
}

function findClassConstructor(cls: ts.ClassLikeDeclaration): ts.ConstructorDeclaration | null {
  for (const m of cls.members) {
    if (ts.isConstructorDeclaration(m)) return m;
  }
  return null;
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
