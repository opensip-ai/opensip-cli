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

import { isToolErrorLike, logger, yieldToEventLoop } from '@opensip-cli/core';
import {
  createMutableStats,
  ownerEdgeKey,
  pushCreationEdge as pushSharedCreationEdge,
} from '@opensip-cli/graph';

import { throwIfGraphAdapterAborted } from './cancellation.js';
import { createResolutionTrace } from './edge-helpers/resolution-trace.js';
import {
  buildImportBindingSourceIndex,
  buildImportIndex,
  buildImportSpecifierIndex,
  collectKnownFiles,
  type ImportBindingSource,
  resolveSyntactic,
  type ImportIndex,
} from './edge-resolvers/syntactic.js';
import { computeVerdict, pushCallEdge, rebuildCatalog, tsPosition } from './edges-dispatch.js';

import type { CrossPackageContext } from './edge-helpers/cross-package-context.js';
import type { ResolutionTraceSink, ResolverContext } from './edge-resolvers/types.js';
import type { CallSiteRecord } from './walk.js';
import type {
  CallEdge,
  Catalog,
  EdgeSink,
  ResolutionStats,
  ResolveOutput,
} from '@opensip-cli/graph';
import type ts from 'typescript';

type GraphRunDegradation = NonNullable<ResolveOutput['degradations']>[number];
type GraphDegradationCondition = GraphRunDegradation['condition'];

export { isReturnValueDiscarded } from './edges-dispatch.js';

const YIELD_EVERY_CALL_SITES = 250;

export interface EdgeResolutionOutput {
  readonly catalog: Catalog;
  readonly resolutionStats: ResolutionStats;
  readonly degradations: readonly GraphRunDegradation[];
}

export interface EdgeResolutionFromRecordsInput {
  readonly catalog: Catalog;
  readonly program: ts.Program;
  readonly projectDirAbs: string;
  readonly callSites: readonly CallSiteRecord[];
  /**
   * The shared cross-package resolution context, built ONCE per exact resolve
   * stage by `resolveCallSitesExact` and threaded into both call and dependency
   * resolution (P2 Phase 0.4). Building it here would duplicate the manifest
   * read + export-index pass the caller already performed.
   */
  readonly crossPackage: CrossPackageContext;
  readonly signal?: AbortSignal;
}

export async function resolveEdgesFromRecords(
  input: EdgeResolutionFromRecordsInput,
): Promise<EdgeResolutionOutput> {
  // Synchronous checkpoints inside async resolution; there is no promise to detach.
  void throwIfGraphAdapterAborted(input.signal, 'TypeScript exact call resolution');
  logger.info({ evt: 'graph.edges.start', module: 'graph:edges' });
  const checker = input.program.getTypeChecker();
  const callsByHash = new Map<string, CallEdge[]>();
  const stats = createMutableStats();
  const sink = { edgesByOwner: callsByHash, stats };

  const resolutionTrace = createResolutionTrace();
  const importSpecifiersByFile = new Map<ts.SourceFile, ReadonlyMap<string, string>>();
  const state: ExactResolutionState = {
    input,
    checker,
    sink,
    importSpecifiersByFile,
    resolutionTrace,
  };
  let degradedCallSites = 0;

  let processed = 0;
  for (const r of input.callSites) {
    if (processed > 0 && processed % YIELD_EVERY_CALL_SITES === 0) {
      await yieldToEventLoop();
      void throwIfGraphAdapterAborted(input.signal, 'TypeScript exact call resolution');
    }
    processed += 1;
    if (resolveExactRecord(r, state)) degradedCallSites += 1;
  }

  void throwIfGraphAdapterAborted(input.signal, 'TypeScript exact call resolution');

  const newCatalog = rebuildCatalog(input.catalog, callsByHash);

  logger.info({
    evt: 'graph.edges.complete',
    module: 'graph:edges',
    totalCallSites: stats.totalCallSites,
    resolvedHigh: stats.resolvedHigh,
    resolvedMedium: stats.resolvedMedium,
    resolvedLow: stats.resolvedLow,
    unresolved: stats.unresolved,
    degradedCallSites,
  });

  return {
    catalog: newCatalog,
    resolutionStats: stats,
    degradations: resolutionDegradations('typescript-exact-resolution', degradedCallSites),
  };
}

export interface EdgeResolutionSyntacticInput {
  readonly catalog: Catalog;
  readonly projectDirAbs: string;
  readonly callSites: readonly CallSiteRecord[];
  readonly signal?: AbortSignal;
}

export async function resolveEdgesSyntactic(
  input: EdgeResolutionSyntacticInput,
): Promise<EdgeResolutionOutput> {
  // Synchronous checkpoints inside async resolution; there is no promise to detach.
  void throwIfGraphAdapterAborted(input.signal, 'TypeScript syntactic call resolution');
  logger.info({ evt: 'graph.edges.syntactic.start', module: 'graph:edges' });
  const callsByHash = new Map<string, CallEdge[]>();
  const stats = createMutableStats();
  const sink = { edgesByOwner: callsByHash, stats };
  const knownFiles = collectKnownFiles(input.catalog);
  const importIndexByFile = new Map<ts.SourceFile, ImportIndex>();
  const importBindingsByFile = new Map<ts.SourceFile, ReadonlyMap<string, ImportBindingSource>>();
  const state: SyntacticResolutionState = {
    input,
    sink,
    knownFiles,
    importIndexByFile,
    importBindingsByFile,
  };
  let degradedCallSites = 0;

  let processed = 0;
  for (const r of input.callSites) {
    if (processed > 0 && processed % YIELD_EVERY_CALL_SITES === 0) {
      await yieldToEventLoop();
      void throwIfGraphAdapterAborted(input.signal, 'TypeScript syntactic call resolution');
    }
    processed += 1;
    if (resolveSyntacticRecord(r, state)) degradedCallSites += 1;
  }

  void throwIfGraphAdapterAborted(input.signal, 'TypeScript syntactic call resolution');

  const newCatalog = rebuildCatalog(input.catalog, callsByHash);

  logger.info({
    evt: 'graph.edges.syntactic.complete',
    module: 'graph:edges',
    totalCallSites: stats.totalCallSites,
    resolvedMedium: stats.resolvedMedium,
    resolvedLow: stats.resolvedLow,
    unresolved: stats.unresolved,
    degradedCallSites,
  });

  return {
    catalog: newCatalog,
    resolutionStats: stats,
    degradations: resolutionDegradations('typescript-syntactic-resolution', degradedCallSites),
  };
}

interface ExactResolutionState {
  readonly input: EdgeResolutionFromRecordsInput;
  readonly checker: ts.TypeChecker;
  readonly sink: EdgeSink;
  readonly importSpecifiersByFile: Map<ts.SourceFile, ReadonlyMap<string, string>>;
  readonly resolutionTrace?: ResolutionTraceSink;
}

function resolveExactRecord(record: CallSiteRecord, state: ExactResolutionState): boolean {
  const ownerKey = callSiteOwnerKey(record, state.input.projectDirAbs);
  if (record.kind === 'creation') {
    pushCreationRecord(record, ownerKey, state.sink);
    return false;
  }
  let importSpecifiers = state.importSpecifiersByFile.get(record.sourceFile);
  if (importSpecifiers === undefined) {
    importSpecifiers = buildImportSpecifierIndex(record.sourceFile);
    state.importSpecifiersByFile.set(record.sourceFile, importSpecifiers);
  }
  let degraded = false;
  const ctx: ResolverContext = {
    catalog: state.input.catalog,
    program: state.input.program,
    typeChecker: state.checker,
    sourceFile: record.sourceFile,
    projectDirAbs: state.input.projectDirAbs,
    crossPackage: state.input.crossPackage,
    importSpecifiers,
    resolutionTrace: state.resolutionTrace,
    recordResolutionDegradation: () => {
      degraded = true;
    },
  };
  try {
    const verdict = computeVerdict(record.node, ctx);
    if (verdict !== null)
      pushCallEdge(record.node, record.sourceFile, verdict, ownerKey, state.sink);
  } catch (error) {
    if (isToolErrorLike(error)) throw error;
    degraded = true;
    state.sink.stats.totalCallSites += 1;
    state.sink.stats.unresolved += 1;
  }
  return degraded;
}

interface SyntacticResolutionState {
  readonly input: EdgeResolutionSyntacticInput;
  readonly sink: EdgeSink;
  readonly knownFiles: ReadonlySet<string>;
  readonly importIndexByFile: Map<ts.SourceFile, ImportIndex>;
  readonly importBindingsByFile: Map<ts.SourceFile, ReadonlyMap<string, ImportBindingSource>>;
}

function resolveSyntacticRecord(record: CallSiteRecord, state: SyntacticResolutionState): boolean {
  const ownerKey = callSiteOwnerKey(record, state.input.projectDirAbs);
  if (record.kind === 'creation') {
    pushCreationRecord(record, ownerKey, state.sink);
    return false;
  }
  const importIndex = cachedImportIndex(record.sourceFile, state);
  const importBindings = cachedImportBindings(record.sourceFile, state);
  const currentFileRel = relative(state.input.projectDirAbs, record.sourceFile.fileName)
    .split(sep)
    .join('/');
  try {
    const verdict = resolveSyntactic(record.node, {
      catalog: state.input.catalog,
      currentFileRel,
      importIndex,
      importBindings,
    });
    if (verdict !== null)
      pushCallEdge(record.node, record.sourceFile, verdict, ownerKey, state.sink);
    return false;
  } catch (error) {
    if (isToolErrorLike(error)) throw error;
    state.sink.stats.totalCallSites += 1;
    state.sink.stats.unresolved += 1;
    return true;
  }
}

function cachedImportIndex(
  sourceFile: ts.SourceFile,
  state: SyntacticResolutionState,
): ImportIndex {
  let value = state.importIndexByFile.get(sourceFile);
  if (value === undefined) {
    value = buildImportIndex(sourceFile, state.input.projectDirAbs, state.knownFiles);
    state.importIndexByFile.set(sourceFile, value);
  }
  return value;
}

function cachedImportBindings(
  sourceFile: ts.SourceFile,
  state: SyntacticResolutionState,
): ReadonlyMap<string, ImportBindingSource> {
  let value = state.importBindingsByFile.get(sourceFile);
  if (value === undefined) {
    value = buildImportBindingSourceIndex(sourceFile);
    state.importBindingsByFile.set(sourceFile, value);
  }
  return value;
}

function callSiteOwnerKey(record: CallSiteRecord, projectDirAbs: string): string {
  return ownerEdgeKey(
    record.ownerHash,
    relative(projectDirAbs, record.sourceFile.fileName).split(sep).join('/'),
    record.ownerLine,
    record.ownerColumn,
  );
}

function pushCreationRecord(record: CallSiteRecord, ownerKey: string, sink: EdgeSink): void {
  if (record.childHash === undefined) return;
  pushSharedCreationEdge(
    tsPosition(record.node, record.sourceFile),
    ownerKey,
    record.childHash,
    sink,
  );
}

function resolutionDegradations(
  condition: Extract<
    GraphDegradationCondition,
    'typescript-exact-resolution' | 'typescript-syntactic-resolution'
  >,
  count: number,
): readonly GraphRunDegradation[] {
  return count === 0
    ? []
    : [
        {
          errorCode: 'GRAPH.ANALYSIS.SEMANTIC_RESOLUTION_DEGRADED',
          condition,
          count,
        },
      ];
}
