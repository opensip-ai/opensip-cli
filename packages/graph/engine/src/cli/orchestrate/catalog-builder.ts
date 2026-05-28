/**
 * Full-rebuild and incremental-rebuild catalog assembly.
 *
 * Owns the parse → walk → resolve stages and stitches the resolver's
 * edge map into the catalog skeleton. The `ParsedProject` is created
 * inside each rebuild path and stays internal so V8 can reclaim the
 * AST as soon as `resolveCallSites` returns.
 *
 * `runStage` is passed in by the orchestrator so we don't reimport
 * the progress/pressure-monitor wrapper here.
 */

import {
  expandClosureToFixpoint,
  mergeOccurrences,
  mergeResolvedAndCachedEdges,
} from './incremental-merge.js';

import type {
  DiscoverOutput,
  GraphLanguageAdapter,
} from '../../lang-adapter/types.js';
import type {
  Catalog,
  CallEdge,
  FunctionOccurrence,
  ResolutionStats,
} from '../../types.js';
import type { GraphProgressCallback, GraphStage } from '../orchestrate.js';
import type { PressureMonitor } from '../pressure-monitor.js';

/**
 * Shape of the `runStage` helper passed in by the orchestrator.
 * Kept here as a type alias so catalog-builder doesn't import the
 * concrete function (which lives in orchestrate.ts at the parent
 * level) and we avoid a circular dependency.
 */
export type RunStage = <T>(
  stage: GraphStage,
  onProgress: GraphProgressCallback | undefined,
  monitor: PressureMonitor | undefined,
  fn: () => T,
  detailFn?: (result: T) => string | undefined,
) => T;

/**
 * Run Stage 1 + Stage 2 and return only the catalog and resolution
 * stats. The parsed project is created inside this function and does
 * not escape — once edge resolution returns, it is unreachable from
 * any caller, so V8 can reclaim the bound AST before Stage 3
 * (`buildIndexes`) and the cache write run.
 */
export function buildAndResolveCatalog(
  runStage: RunStage,
  adapter: GraphLanguageAdapter,
  discovery: DiscoverOutput,
  onProgress?: GraphProgressCallback,
  monitor?: PressureMonitor,
): { readonly catalog: Catalog; readonly resolutionStats: ResolutionStats } {
  // Phase 4 unified walk: Stage 1's catalog construction and Stage 2's
  // call-site location share a single AST descent per file. The walk
  // emits the catalog plus a flat list of pre-located call-site
  // records; resolveCallSites dispatches resolvers without re-walking.
  const parsed = runStage(
    'parse',
    onProgress,
    monitor,
    () => adapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
    }),
    () => adapter.displayName,
  );
  const walked = runStage(
    'walk',
    onProgress,
    monitor,
    () => adapter.walkProject({
      project: parsed.project,
      files: discovery.files,
      projectDirAbs: discovery.projectDirAbs,
    }),
    (w) => `${String(Object.keys(w.occurrences).length)} functions`,
  );

  const initialCatalog = assembleCatalog(adapter, discovery, walked.occurrences);

  const resolved = runStage(
    'resolve',
    onProgress,
    monitor,
    () => adapter.resolveCallSites({
      project: parsed.project,
      catalog: initialCatalog,
      callSites: walked.callSites,
      projectDirAbs: discovery.projectDirAbs,
    }),
    (r) => `${String(r.stats.totalCallSites)} call site(s)`,
  );

  const catalog = stitchEdges(initialCatalog, resolved.edgesByOwner);
  return { catalog, resolutionStats: resolved.stats };
}

/**
 * Wave 4 incremental rebuild — re-walk only changed files plus their
 * transitive edge-dependents, then merge with cached entries for
 * unchanged files.
 *
 * Algorithm:
 *   1. Parse the project once over ALL current files (the resolver
 *      pass needs the full program for cross-file symbol lookup).
 *   2. Convert the absolute changed-files set to project-relative
 *      paths so we can match the catalog's filePath field.
 *   3. Iterate to fixpoint: walk closure files, identify hashes that
 *      vanished or changed, find unchanged files whose cached edges
 *      reference those hashes, add them to the closure, repeat until
 *      no new dependents are discovered.
 *   4. Merge cached entries for files NOT in the closure with
 *      freshly-walked-and-resolved entries for files IN the closure.
 *
 * Correctness vs full rebuild: every file whose cached edges might
 * point at a stale hash is itself re-walked. After the fixpoint, no
 * cached edge dangles. Verified by `incremental rebuild produces a
 * catalog identical to a full rebuild` test.
 */
export function buildAndResolveCatalogIncremental(
  runStage: RunStage,
  adapter: GraphLanguageAdapter,
  discovery: DiscoverOutput,
  cachedCatalog: Catalog,
  changedFilesAbs: readonly string[],
  onProgress?: GraphProgressCallback,
  monitor?: PressureMonitor,
): { readonly catalog: Catalog; readonly resolutionStats: ResolutionStats } {
  const parsed = runStage(
    'parse',
    onProgress,
    monitor,
    () => adapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
    }),
    () => `${adapter.displayName} (incremental)`,
  );

  const { walked, closureRel } = runStage(
    'walk',
    onProgress,
    monitor,
    () => expandClosureToFixpoint({
      adapter,
      discovery,
      cachedCatalog,
      parsedProject: parsed.project,
      changedFilesAbs,
    }),
    (out) => `${String(out.closureRel.size)} closure file(s)`,
  );

  // Build the resolver-input catalog from the merged occurrence set
  // so name- and hash-based fallbacks see the full project.
  const mergedFunctions = mergeOccurrences(cachedCatalog, walked.occurrences, closureRel);
  const initialCatalog = {
    ...assembleCatalog(adapter, discovery, mergedFunctions as Record<string, FunctionOccurrence[]>),
    functions: mergedFunctions,
  } as Catalog;

  const resolved = runStage(
    'resolve',
    onProgress,
    monitor,
    () => adapter.resolveCallSites({
      project: parsed.project,
      catalog: initialCatalog,
      callSites: walked.callSites,
      projectDirAbs: discovery.projectDirAbs,
    }),
    (r) => `${String(r.stats.totalCallSites)} call site(s)`,
  );

  // Apply resolved edges only to closure files; unchanged files keep
  // their cached edges. Their bodyHashes are present in the merged
  // catalog by construction, so cached edges are still valid.
  const finalFunctions = mergeResolvedAndCachedEdges(
    initialCatalog,
    cachedCatalog,
    resolved.edgesByOwner,
    closureRel,
  );
  const finalCatalog: Catalog = { ...initialCatalog, functions: finalFunctions };

  return { catalog: finalCatalog, resolutionStats: resolved.stats };
}

/**
 * Build the catalog skeleton from walked occurrences. The catalog has
 * empty `calls` arrays at this point; `resolveCallSites` produces the
 * edges, and `stitchEdges` writes them in.
 */
function assembleCatalog(
  adapter: GraphLanguageAdapter,
  discovery: DiscoverOutput,
  occurrences: Record<string, FunctionOccurrence[]>,
): Catalog {
  return {
    version: '3.0',
    tool: 'graph',
    language: adapter.id,
    builtAt: new Date().toISOString(),
    cacheKey: adapter.cacheKey({
      projectDirAbs: discovery.projectDirAbs,
      configPathAbs: discovery.configPathAbs,
      compilerOptions: discovery.compilerOptions,
    }),
    functions: occurrences,
  };
}

/**
 * Stitch resolved edges into the catalog. The adapter returns a
 * `bodyHash → CallEdge[]` map; we walk the catalog and replace each
 * occurrence's `calls` array with the resolved edges (or an empty
 * array if the resolver produced none).
 */
function stitchEdges(
  initial: Catalog,
  edgesByOwner: ReadonlyMap<string, readonly CallEdge[]>,
): Catalog {
  const next: Record<string, FunctionOccurrence[]> = Object.create(null) as Record<
    string,
    FunctionOccurrence[]
  >;
  for (const [name, occs] of Object.entries(initial.functions)) {
    if (!occs) continue;
    next[name] = occs.map((o) => ({
      ...o,
      calls: edgesByOwner.get(o.bodyHash) ?? [],
    }));
  }
  return { ...initial, functions: next };
}
