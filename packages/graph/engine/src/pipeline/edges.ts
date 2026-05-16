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

import { findCatalogEntry } from './edge-helpers/find-catalog-entry.js';
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

    // Record a creation edge from the parent owner to this nested
    // function ONLY for inline-callables: arrows, function
    // expressions, and class members (methods / constructors /
    // accessors). These are alive whenever their enclosing scope is
    // alive — they are never "called by name." Function declarations
    // are deliberately excluded; they need a real call edge to be
    // considered reachable, which is what makes the orphan rule
    // catch genuinely unused top-level functions.
    if (
      hash !== null &&
      ownerHash !== null &&
      hash !== ownerHash &&
      isInlineCallable(node)
    ) {
      recordCreationEdge(node, ownerHash, hash, args);
    }

    ts.forEachChild(node, (c) => { walk(c, childOwner); });
  }

  // Descend from the source file. Module-init owns everything that's
  // not inside a function-shaped node.
  ts.forEachChild(args.sourceFile, (c) => { walk(c, moduleInitHash); });
}

function recordCreationEdge(
  node: ts.Node,
  ownerHash: string,
  childHash: string,
  args: WalkArgs,
): void {
  const start = node.getStart(args.sourceFile);
  const startLC = args.sourceFile.getLineAndCharacterOfPosition(start);
  const text = node.getText(args.sourceFile);
  const truncated = text.length > 70 ? `${text.slice(0, 67)}...` : text;
  const edge: CallEdge = {
    to: [childHash],
    line: startLC.line + 1,
    column: startLC.character,
    resolution: 'static',
    confidence: 'high',
    text: `[creates] ${truncated}`,
  };
  const list = args.callsByHash.get(ownerHash);
  if (list) {
    list.push(edge);
  } else {
    args.callsByHash.set(ownerHash, [edge]);
  }
  args.stats.totalCallSites++;
  args.stats.resolvedHigh++;
}

function maybeCollectCallSite(node: ts.Node, ownerHash: string, args: WalkArgs): void {
  const verdict = computeVerdict(node, args.ctx);
  if (verdict === null) return;
  args.stats.totalCallSites++;
  pushEdge(node, verdict, ownerHash, args);
}

/** Returns null if `node` is not a call/new/jsx/value-reference site. */
function computeVerdict(node: ts.Node, ctx: ResolverContext): ResolverVerdict | null {
  if (ts.isCallExpression(node)) return dispatchCall(node, ctx);
  if (ts.isNewExpression(node)) return resolveNewExpression(node, ctx);
  if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
    return resolveJsxElement(node, ctx);
  }
  if (ts.isIdentifier(node) && isValueReference(node)) {
    const v = resolveValueReference(node, ctx);
    return v.to.length > 0 ? v : null;
  }
  if (ts.isShorthandPropertyAssignment(node)) {
    const v = resolveShorthandAssignment(node, ctx);
    return v.to.length > 0 ? v : null;
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

/**
 * An inline callable is an arrow / function-expression / method /
 * accessor whose only call path is the value it produces (callback,
 * property assignment, instance method via dispatch, etc.).
 *
 * Methods/getters/setters/constructors get a creation edge from
 * their enclosing class declaration's owner: an instance method is
 * alive whenever the class is instantiated, and we don't always
 * resolve method-dispatch perfectly. The creation edge keeps a
 * reachable class's members reachable without depending on
 * type-checker accuracy for every dispatch site.
 */
function isInlineCallable(node: ts.Node): boolean {
  return (
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
