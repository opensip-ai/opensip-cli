// @fitness-ignore-file file-length-limit -- Stage 2 edge resolver covering call+import+dependency edges in one cohesive pass; the resolution logic is contiguous and a split would push state across module boundaries.
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
  ownerEdgeKey,
  pushCreationEdge as pushSharedCreationEdge,
  resolveSpecifierToPackage,
  truncateForCallEdge,
} from '@opensip-tools/graph';
import ts from 'typescript';

import { buildCrossPackageContext } from './edge-helpers/cross-package-context.js';
import { DeclShape, functionLikeFromDeclaration } from './edge-helpers/declaration-to-node.js';
import { unaliasSymbol } from './edge-helpers/unalias-symbol.js';
import { resolveByCatalogFallback } from './edge-resolvers/catalog-fallback.js';
import { resolveDirectCall } from './edge-resolvers/direct-call.js';
import { resolveJsxElement } from './edge-resolvers/jsx-element.js';
import { resolveNewExpression } from './edge-resolvers/new-expression.js';
import { resolvePolymorphicCall } from './edge-resolvers/polymorphic.js';
import { resolvePropertyAccessCall } from './edge-resolvers/property-access.js';
import {
  buildImportIndex,
  buildImportSpecifierIndex,
  calleeAnchorNode,
  collectKnownFiles,
  resolveSyntactic,
  type ImportIndex,
} from './edge-resolvers/syntactic.js';
import {
  isValueReference,
  resolveShorthandAssignment,
  resolveValueReference,
} from './edges-value-reference.js';

import type { ResolverContext } from './edge-resolvers/types.js';
import type { CallSiteRecord } from './walk.js';
import type {
  CallEdge,
  Catalog,
  EdgeSink,
  FunctionOccurrence,
  ResolutionStats,
  ResolverVerdict,
} from '@opensip-tools/graph';

/** How many call sites to process between cooperative event-loop yields. Tuned
 *  so the live view's 80ms clock ticks several times per second during a long
 *  resolve, while keeping the macrotask-hop count (and its overhead) tiny. */
const YIELD_EVERY_CALL_SITES = 250;

/** Yield to the event loop once (a macrotask hop), so the in-process live view
 *  can paint a frame mid-stage (ADR-0016). */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function tsPosition(
  node: ts.Node,
  sourceFile: ts.SourceFile,
): {
  readonly line: number;
  readonly column: number;
  readonly text: string;
} {
  // Anchor the edge identity at the CALLEE token (method name / callee / class),
  // not the whole expression's start — so chained calls `a().b()` don't collide
  // on one (line,column) key. The display TEXT stays the whole expression.
  const anchor = calleeAnchorNode(node).getStart(sourceFile);
  const anchorLC = sourceFile.getLineAndCharacterOfPosition(anchor);
  return {
    line: anchorLC.line + 1,
    column: anchorLC.character,
    text: sourceFile.text.slice(node.getStart(sourceFile), node.getEnd()),
  };
}

/** Output of TS edge resolution: catalog (with edges populated) and per-stage stats. */
export interface EdgeResolutionOutput {
  readonly catalog: Catalog;
  readonly resolutionStats: ResolutionStats;
}

/** Input for re-resolving edges from cached {@link CallSiteRecord} arrays (warm path). */
export interface EdgeResolutionFromRecordsInput {
  readonly catalog: Catalog;
  readonly program: ts.Program;
  readonly projectDirAbs: string;
  readonly callSites: readonly CallSiteRecord[];
}

/**
 * Stage 2 entry point: resolve a pre-collected list of call-site records
 * produced by `walkProgram` (no AST re-descent). The orchestrator's
 * `resolveCallSitesAdapter` drives this directly with the records the walk
 * already emitted.
 */
export async function resolveEdgesFromRecords(
  input: EdgeResolutionFromRecordsInput,
): Promise<EdgeResolutionOutput> {
  logger.info({ evt: 'graph.edges.start', module: 'graph:edges' });
  const checker = input.program.getTypeChecker();
  const callsByHash = new Map<string, CallEdge[]>();
  const stats = createMutableStats();
  const sink: EdgeSink = { edgesByOwner: callsByHash, stats };

  // Cross-package resolution context (export index + manifest index) — the SAME
  // model the sharded linker uses. Built once for the whole resolve stage so a
  // workspace `@scope/pkg` call resolves to the SOURCE occurrence instead of the
  // type checker's bodiless `dist/*.d.ts` declaration (ADR — exact↔sharded
  // convergence). The per-file raw-import-specifier index (binding name → raw
  // specifier) is built lazily and cached, mirroring the boundary extractor.
  const crossPackage = buildCrossPackageContext(input.catalog, input.projectDirAbs);
  // One import-specifier index per source file, built lazily and cached inline in
  // the loop below (the cache Map is a local of THIS function, like the fast
  // path's `importIndexByFile`).
  const importSpecifiersByFile = new Map<ts.SourceFile, ReadonlyMap<string, string>>();

  let processed = 0;
  for (const r of input.callSites) {
    // Cooperative yield (ADR-0016): resolve is the heaviest stage (tens of
    // thousands of sites). Yielding to the event loop every N sites lets the
    // in-process live view's 80ms clock tick, so the spinner animates instead
    // of freezing for the whole stage. The macrotask hops (~1 per N sites) are
    // negligible against the per-site type-checker work.
    if (processed > 0 && processed % YIELD_EVERY_CALL_SITES === 0) await yieldToEventLoop();
    processed += 1;
    // Bucket edges per OWNER OCCURRENCE (bodyHash + file), not bodyHash alone:
    // body-twin functions in different files share a hash, and a hash-only
    // bucket would union their edges into phantom cross-package calls.
    const ownerKey = ownerEdgeKey(
      r.ownerHash,
      relative(input.projectDirAbs, r.sourceFile.fileName),
    );
    if (r.kind === 'creation') {
      if (r.childHash === undefined) continue;
      // @fitness-ignore-next-line detached-promises -- pushCallEdge/pushSharedCreationEdge return void (synchronous edge-sink writes), not promises
      pushSharedCreationEdge(tsPosition(r.node, r.sourceFile), ownerKey, r.childHash, sink);
      continue;
    }
    let importSpecifiers = importSpecifiersByFile.get(r.sourceFile);
    if (importSpecifiers === undefined) {
      importSpecifiers = buildImportSpecifierIndex(r.sourceFile);
      importSpecifiersByFile.set(r.sourceFile, importSpecifiers);
    }
    const ctx: ResolverContext = {
      catalog: input.catalog,
      program: input.program,
      typeChecker: checker,
      sourceFile: r.sourceFile,
      projectDirAbs: input.projectDirAbs,
      crossPackage,
      importSpecifiers,
    };
    const verdict = computeVerdict(r.node, ctx);
    if (verdict === null) continue;
    // @fitness-ignore-next-line detached-promises -- pushCallEdge/pushSharedCreationEdge return void (synchronous edge-sink writes), not promises
    pushCallEdge(r.node, r.sourceFile, verdict, ownerKey, sink);
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

/** Input for the fast (syntactic, checker-free) resolve path. */
export interface EdgeResolutionSyntacticInput {
  readonly catalog: Catalog;
  readonly projectDirAbs: string;
  readonly callSites: readonly CallSiteRecord[];
}

/**
 * Fast-tier Stage 2 entry point: resolve the same pre-collected call-site
 * records WITHOUT a `ts.Program` or type checker. Creation edges are
 * static and handled identically to the exact path; call edges are
 * resolved syntactically (callee name + the file's import graph) and
 * labeled `resolution: 'syntactic'` with capped confidence (never
 * `'high'`). The output shape is identical to {@link resolveEdgesFromRecords}
 * — only the verdicts differ — so the catalog stitches the same way.
 *
 * Stats stay honest: fast edges land in `resolvedMedium`/`resolvedLow`/
 * `unresolved`, never `resolvedHigh`.
 */
export async function resolveEdgesSyntactic(
  input: EdgeResolutionSyntacticInput,
): Promise<EdgeResolutionOutput> {
  logger.info({ evt: 'graph.edges.syntactic.start', module: 'graph:edges' });
  const callsByHash = new Map<string, CallEdge[]>();
  const stats = createMutableStats();
  const sink: EdgeSink = { edgesByOwner: callsByHash, stats };
  const knownFiles = collectKnownFiles(input.catalog);
  // One import index per source file — cached across that file's sites.
  const importIndexByFile = new Map<ts.SourceFile, ImportIndex>();

  let processed = 0;
  for (const r of input.callSites) {
    // Cooperative yield — see resolveEdgesFromRecords (ADR-0016).
    // @fitness-ignore-next-line performance-anti-patterns -- cooperative yield (ADR-0016) runs once per N call-sites so the live view stays responsive; intentionally serial, not parallelizable
    if (processed > 0 && processed % YIELD_EVERY_CALL_SITES === 0) await yieldToEventLoop();
    processed += 1;
    // Per-owner-occurrence bucket key (see resolveEdgesFromRecords).
    const ownerKey = ownerEdgeKey(
      r.ownerHash,
      relative(input.projectDirAbs, r.sourceFile.fileName),
    );
    if (r.kind === 'creation') {
      if (r.childHash === undefined) continue;
      // @fitness-ignore-next-line detached-promises -- pushCallEdge/pushSharedCreationEdge return void (synchronous edge-sink writes), not promises
      pushSharedCreationEdge(tsPosition(r.node, r.sourceFile), ownerKey, r.childHash, sink);
      continue;
    }
    let importIndex = importIndexByFile.get(r.sourceFile);
    if (importIndex === undefined) {
      importIndex = buildImportIndex(r.sourceFile, input.projectDirAbs, knownFiles);
      importIndexByFile.set(r.sourceFile, importIndex);
    }
    const currentFileRel = relative(input.projectDirAbs, r.sourceFile.fileName)
      .split(sep)
      .join('/');
    const verdict = resolveSyntactic(r.node, {
      catalog: input.catalog,
      currentFileRel,
      importIndex,
    });
    if (verdict === null) continue;
    // @fitness-ignore-next-line detached-promises -- pushCallEdge/pushSharedCreationEdge return void (synchronous edge-sink writes), not promises
    pushCallEdge(r.node, r.sourceFile, verdict, ownerKey, sink);
  }

  const newCatalog = rebuildCatalog(input.catalog, callsByHash);

  logger.info({
    evt: 'graph.edges.syntactic.complete',
    module: 'graph:edges',
    totalCallSites: stats.totalCallSites,
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

/** Returns null if `node` is not a call/new/jsx/value-reference site. */
function computeVerdict(node: ts.Node, ctx: ResolverContext): ResolverVerdict | null {
  for (const entry of VERDICT_TABLE) {
    if (entry.predicate(node)) return entry.resolve(node, ctx);
  }
  return null;
}

function dispatchCall(node: ts.CallExpression, ctx: ResolverContext): ResolverVerdict {
  // Direct identifier call: foo()
  if (ts.isIdentifier(node.expression)) {
    const direct = resolveDirectCall(node, ctx);
    if (direct.to.length > 0) return direct;
    return fallbackWithBinding(node.expression, node.expression.text, ctx);
  }
  // Property access call: obj.method()
  if (ts.isPropertyAccessExpression(node.expression)) {
    const direct = resolvePropertyAccessCall(node, ctx);
    if (direct.to.length > 0) return direct;
    const poly = resolvePolymorphicCall(node, ctx);
    if (poly.to.length > 0) return poly;
    // Fallback: look up by the rightmost simple name (binding-gated).
    return fallbackWithBinding(node.expression, node.expression.name.text, ctx);
  }
  return { to: [], resolution: 'unknown', confidence: 'low' };
}

const UNRESOLVED_VERDICT: ResolverVerdict = { to: [], resolution: 'unknown', confidence: 'low' };

/**
 * Binding-gated catalog fallback. The unique-name catalog lookup
 * ({@link resolveByCatalogFallback}) only fires when the call site has a binding
 * that points INTO the project. A project binding is any of:
 *
 *   - the callee expression's resolved symbol has an IN-PROJECT SOURCE
 *     declaration (a `.ts(x)` file, not a `.d.ts`). This is the receiver/type
 *     case the import graph can't see: `g.greet()` where `g: Greeter` resolves
 *     to the interface method declared in a project source file, even though
 *     `greet` was never imported by name;
 *   - the name is imported via a RELATIVE specifier (`./x`) — intra-package; or
 *   - the name is imported via a WORKSPACE specifier (`@scope/pkg`) the manifest
 *     index knows — inter-package.
 *
 * A callee whose symbol resolves only into an EXTERNAL/ambient `.d.ts` (Vitest's
 * `describe`, `process.cwd`, a `Map`'s `.set`/`.get`) has NO project binding:
 * the real target is outside the catalog, so a unique project function sharing
 * the simple name would be a phantom. Without a project binding we decline —
 * decline-beats-guess.
 *
 * NOTE: a same-named function merely EXISTING in the caller's file is NOT a
 * binding — its presence is no evidence THIS call targets it. The former
 * same-file name-presence branch let `process.send()` / `arr.push()` /
 * `new Map().has()` / core `logger.info()` enter the name-only catalog fallback,
 * which then resolved by SHARD-SCOPED catalog uniqueness — unsound under sharding
 * (unique-in-shard ≠ unique-in-repo). That fabricated 33 local same-name edges on
 * this repo (a cross-package/external method call → a same-file same-name
 * function) that the whole-program checker correctly declines. Removed:
 * decline-beats-guess. (Genuine cross-package edges sharded *does* resolve come
 * from the type-checker resolvers' `.d.ts`→source hop, not this fallback, so they
 * are unaffected.)
 */
function fallbackWithBinding(
  calleeExpr: ts.Expression,
  name: string,
  ctx: ResolverContext,
): ResolverVerdict {
  if (!hasProjectBinding(calleeExpr, name, ctx)) return UNRESOLVED_VERDICT;
  return resolveByCatalogFallback(name, ctx.catalog);
}

/** True when the call's callee binds into the project (see {@link fallbackWithBinding}). */
function hasProjectBinding(calleeExpr: ts.Expression, name: string, ctx: ResolverContext): boolean {
  if (symbolHasInProjectSourceDecl(calleeExpr, ctx)) return true;
  const spec = ctx.importSpecifiers.get(name);
  if (spec !== undefined) {
    if (spec.startsWith('.')) return true; // relative → intra-project
    // Bare specifier → only a project binding if it resolves to a workspace pkg.
    return resolveSpecifierToPackage(spec, ctx.crossPackage.manifestIndex) !== undefined;
  }
  // No type-checked in-project binding and no import specifier ⇒ no binding.
  // (A same-named function merely existing in this file is not a binding — see
  // the fallbackWithBinding doc. Declining here is the decline-beats-guess floor.)
  return false;
}

/** Concrete-callable declaration shapes a name-only fallback may resolve against
 *  — excludes parameters / property- and method-signatures (a function-TYPED
 *  binding whose actual target the fallback cannot know). Mirrors the
 *  property-access resolver's ACCEPT set. */
const CALLABLE_DECL =
  DeclShape.FunctionDeclaration |
  DeclShape.ArrowFunction |
  DeclShape.FunctionExpression |
  DeclShape.MethodDeclaration |
  DeclShape.ConstructorDeclaration |
  DeclShape.Accessor |
  DeclShape.VariableInitializer |
  DeclShape.PropertyAssignmentInitializer;

/**
 * True when the callee expression's resolved symbol has at least one declaration
 * in an IN-PROJECT SOURCE file (a non-`.d.ts` source file in the program). This
 * is the binding the import graph can't express: a receiver-typed method call
 * (`g.greet()` where `g: Greeter`) whose target is declared in project source,
 * even though the method name was never imported. A symbol that resolves only
 * into `.d.ts` (external / ambient) declarations fails this check, so the
 * name-only fallback stays declined for globals.
 */
function symbolHasInProjectSourceDecl(calleeExpr: ts.Expression, ctx: ResolverContext): boolean {
  const symbol = ctx.typeChecker.getSymbolAtLocation(calleeExpr);
  if (!symbol) return false;
  const real = unaliasSymbol(symbol, ctx.typeChecker);
  for (const d of real.getDeclarations() ?? []) {
    // Only a CONCRETE CALLABLE source declaration is a binding the name-only
    // fallback may resolve against. A parameter / property-signature / method-
    // signature (`options.shouldNotRetry?.()`, `push: PushViolation`) is NOT —
    // the call's real target is whatever VALUE flows into it, which the shard-
    // scoped name fallback cannot know, so it guesses a same-name occurrence
    // (resolved when unique IN THE SHARD, declined when ambiguous WHOLE-PROGRAM
    // — the exact↔sharded divergence). Gating to a callable decl declines those
    // guesses in BOTH engines: decline-beats-guess, and convergent.
    if (
      !d.getSourceFile().isDeclarationFile &&
      functionLikeFromDeclaration(d, CALLABLE_DECL) !== null
    ) {
      return true;
    }
  }
  return false;
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
      calls: callsByHash.get(ownerEdgeKey(o.bodyHash, o.filePath)) ?? [],
    }));
  }
  return { ...catalog, functions };
}
