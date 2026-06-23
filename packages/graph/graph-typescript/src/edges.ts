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

import { logger } from '@opensip-cli/core';
import {
  createMutableStats,
  ownerEdgeKey,
  pushCreationEdge as pushSharedCreationEdge,
} from '@opensip-cli/graph';
import ts from 'typescript';

import { buildCrossPackageContext } from './edge-helpers/cross-package-context.js';
import {
  buildImportIndex,
  buildImportSpecifierIndex,
  collectKnownFiles,
  resolveSyntactic,
  type ImportIndex,
} from './edge-resolvers/syntactic.js';
import {
  computeVerdict,
  pushCallEdge,
  rebuildCatalog,
  tsPosition,
} from './edges-dispatch.js';

import type { ResolverContext } from './edge-resolvers/types.js';
import type { CallSiteRecord } from './walk.js';
import type { CallEdge, Catalog, ResolutionStats } from '@opensip-cli/graph';

export { isReturnValueDiscarded } from './edges-dispatch.js';

const YIELD_EVERY_CALL_SITES = 250;

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
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

export async function resolveEdgesFromRecords(
  input: EdgeResolutionFromRecordsInput,
): Promise<EdgeResolutionOutput> {
  logger.info({ evt: 'graph.edges.start', module: 'graph:edges' });
  const checker = input.program.getTypeChecker();
  const callsByHash = new Map<string, CallEdge[]>();
  const stats = createMutableStats();
  const sink = { edgesByOwner: callsByHash, stats };

  const crossPackage = buildCrossPackageContext(input.catalog, input.projectDirAbs);
  const importSpecifiersByFile = new Map<ts.SourceFile, ReadonlyMap<string, string>>();

  let processed = 0;
  for (const r of input.callSites) {
    if (processed > 0 && processed % YIELD_EVERY_CALL_SITES === 0) await yieldToEventLoop();
    processed += 1;
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

export interface EdgeResolutionSyntacticInput {
  readonly catalog: Catalog;
  readonly projectDirAbs: string;
  readonly callSites: readonly CallSiteRecord[];
}

export async function resolveEdgesSyntactic(
  input: EdgeResolutionSyntacticInput,
): Promise<EdgeResolutionOutput> {
  logger.info({ evt: 'graph.edges.syntactic.start', module: 'graph:edges' });
  const callsByHash = new Map<string, CallEdge[]>();
  const stats = createMutableStats();
  const sink = { edgesByOwner: callsByHash, stats };
  const knownFiles = collectKnownFiles(input.catalog);
  const importIndexByFile = new Map<ts.SourceFile, ImportIndex>();

  let processed = 0;
  for (const r of input.callSites) {
    // @fitness-ignore-next-line performance-anti-patterns -- cooperative yield (ADR-0016) runs once per N call-sites so the live view stays responsive; intentionally serial, not parallelizable
    if (processed > 0 && processed % YIELD_EVERY_CALL_SITES === 0) await yieldToEventLoop();
    processed += 1;
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