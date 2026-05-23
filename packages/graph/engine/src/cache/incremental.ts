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
 * catalog identical to a full rebuild` test in
 * `__tests__/cli/orchestrate.test.ts`.
 *
 * This module takes a `GraphLanguageAdapter` parameter and never
 * imports from any `lang-*` pack — the same layering the orchestrator
 * follows.
 */

import { relative, sep } from 'node:path';

import { logger } from '@opensip-tools/core';

import type {
  DiscoverOutput,
  GraphLanguageAdapter,
  ParsedProject,
  WalkOutput,
} from '../lang-adapter/types.js';
import type {
  Catalog,
  CallEdge,
  FunctionOccurrence,
  ResolutionStats,
} from '../types.js';

/**
 * Stage runner contract: same shape the orchestrator uses to wrap
 * progress reporting + heap-pressure sampling around each pipeline
 * stage. Threading it as a parameter lets `runIncremental` keep the
 * orchestrator's stage telemetry while staying ignorant of how it's
 * implemented.
 */
export type StageRunner = <T>(
  stage: 'parse' | 'walk' | 'resolve',
  fn: () => T,
  detailFn?: (result: T) => string | undefined,
) => T;

export interface RunIncrementalInput {
  readonly adapter: GraphLanguageAdapter;
  readonly discovery: DiscoverOutput;
  readonly cachedCatalog: Catalog;
  readonly changedFilesAbs: readonly string[];
  /**
   * Stage runner — wraps each of parse/walk/resolve with whatever
   * progress and pressure-monitor instrumentation the caller wants.
   * Pass `(_, fn) => fn()` for a bare invocation in tests.
   */
  readonly runStage: StageRunner;
}

export interface RunIncrementalOutput {
  readonly catalog: Catalog;
  readonly resolutionStats: ResolutionStats;
}

/**
 * Public entry point. Drives the incremental rebuild end-to-end:
 * parse → walk-closure-to-fixpoint → resolve closure → stitch with
 * cached unchanged entries.
 */
export function runIncremental(input: RunIncrementalInput): RunIncrementalOutput {
  const { adapter, discovery, cachedCatalog, changedFilesAbs, runStage } = input;

  const parsed = runStage(
    'parse',
    () => adapter.parseProject({
      projectDirAbs: discovery.projectDirAbs,
      files: discovery.files,
      compilerOptions: discovery.compilerOptions,
    }),
    () => `${adapter.displayName} (incremental)`,
  );

  const { walked, closureRel } = runStage(
    'walk',
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
  const initialCatalog: Catalog = {
    version: '3.0',
    tool: 'graph',
    language: adapter.id,
    builtAt: new Date().toISOString(),
    cacheKey: adapter.cacheKey({
      projectDirAbs: discovery.projectDirAbs,
      configPathAbs: discovery.configPathAbs,
      compilerOptions: discovery.compilerOptions,
    }),
    functions: mergedFunctions,
  };

  const resolved = runStage(
    'resolve',
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

interface ClosureInput {
  readonly adapter: GraphLanguageAdapter;
  readonly discovery: DiscoverOutput;
  readonly cachedCatalog: Catalog;
  readonly parsedProject: ParsedProject;
  readonly changedFilesAbs: readonly string[];
}

interface ClosureOutput {
  readonly walked: WalkOutput;
  readonly closureRel: ReadonlySet<string>;
}

/**
 * Expand the re-walk closure to a fixpoint. Starts with the directly
 * changed files; on each iteration walks the closure, finds hashes
 * that vanished, scans cached edges for any that still point at
 * vanished hashes, and adds those callers to the closure. Stops when
 * no new dependents are discovered.
 */
function expandClosureToFixpoint(input: ClosureInput): ClosureOutput {
  const { adapter, discovery, cachedCatalog, parsedProject, changedFilesAbs } = input;
  const closureRel = new Set(
    changedFilesAbs.map((p) => relative(discovery.projectDirAbs, p).split(sep).join('/')),
  );
  const closureAbs = new Set(changedFilesAbs);
  const cachedHashesByFile = groupCachedHashesByFile(cachedCatalog);

  let walked: WalkOutput | null = null;
  // Iterate to fixpoint. On a typical 1-file change, this loop runs
  // exactly once — a file's hashes generally don't reach into
  // unchanged callers' edges. Worst case is bounded by file count
  // (each iteration adds at least one file).
  for (;;) {
    walked = adapter.walkProject({
      project: parsedProject,
      files: discovery.files.filter((p) => closureAbs.has(p)),
      projectDirAbs: discovery.projectDirAbs,
    });
    const grew = expandClosureOnce(
      walked,
      cachedCatalog,
      closureRel,
      closureAbs,
      cachedHashesByFile,
      discovery.projectDirAbs,
    );
    if (!grew) break;
  }
  if (!walked) {
    throw new Error('incremental walk produced no result; closure was empty');
  }
  return { walked, closureRel };
}

function expandClosureOnce(
  walked: WalkOutput,
  cachedCatalog: Catalog,
  closureRel: Set<string>,
  closureAbs: Set<string>,
  cachedHashesByFile: ReadonlyMap<string, ReadonlySet<string>>,
  projectDirAbs: string,
): boolean {
  const newHashes = collectHashesFromOccurrences(walked.occurrences);
  const staleHashes = collectStaleHashes(closureRel, cachedHashesByFile, newHashes);
  if (staleHashes.size === 0) return false;
  const newDependents = findEdgeDependents(cachedCatalog, staleHashes, closureRel);
  if (newDependents.length === 0) return false;

  let grew = false;
  for (const dep of newDependents) {
    if (closureRel.has(dep)) continue;
    closureRel.add(dep);
    closureAbs.add(`${projectDirAbs}/${dep}`.split('/').join(sep));
    grew = true;
  }
  if (grew) {
    logger.info({
      evt: 'graph.cache.incremental.expand',
      module: 'graph:cache',
      addedDependents: newDependents.length,
      closureSize: closureRel.size,
    });
  }
  return grew;
}

function collectHashesFromOccurrences(
  functions: Record<string, FunctionOccurrence[]>,
): ReadonlySet<string> {
  const out = new Set<string>();
  for (const occs of Object.values(functions)) {
    if (!occs) continue;
    for (const o of occs) out.add(o.bodyHash);
  }
  return out;
}

function collectStaleHashes(
  closureRel: ReadonlySet<string>,
  cachedHashesByFile: ReadonlyMap<string, ReadonlySet<string>>,
  newHashes: ReadonlySet<string>,
): ReadonlySet<string> {
  const stale = new Set<string>();
  for (const fileRel of closureRel) {
    const cachedHashes = cachedHashesByFile.get(fileRel);
    if (!cachedHashes) continue;
    for (const h of cachedHashes) {
      if (!newHashes.has(h)) stale.add(h);
    }
  }
  return stale;
}

function groupCachedHashesByFile(catalog: Catalog): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const occs of Object.values(catalog.functions)) {
    if (!occs) continue;
    for (const o of occs) {
      let set = out.get(o.filePath);
      if (!set) {
        set = new Set();
        out.set(o.filePath, set);
      }
      set.add(o.bodyHash);
    }
  }
  return out;
}

/**
 * Find unchanged files whose cached edges have any `to` containing
 * a hash from `staleHashes`. Used by the incremental closure
 * expansion: if file A's cached edges point at a hash that no longer
 * exists, A must be re-walked too.
 */
function findEdgeDependents(
  catalog: Catalog,
  staleHashes: ReadonlySet<string>,
  alreadyClosed: ReadonlySet<string>,
): readonly string[] {
  const dependents = new Set<string>();
  for (const occs of Object.values(catalog.functions)) {
    if (!occs) continue;
    for (const o of occs) {
      if (alreadyClosed.has(o.filePath)) continue;
      if (dependents.has(o.filePath)) continue;
      if (occHasEdgeIntoStale(o, staleHashes)) dependents.add(o.filePath);
    }
  }
  return [...dependents].sort();
}

function occHasEdgeIntoStale(
  occ: FunctionOccurrence,
  staleHashes: ReadonlySet<string>,
): boolean {
  for (const edge of occ.calls) {
    for (const target of edge.to) {
      if (staleHashes.has(target)) return true;
    }
  }
  return false;
}

/**
 * Merge occurrences: for files in `closureRel`, take the freshly-
 * walked entries; for everything else, take the cached entries.
 * Re-keys by simpleName so the catalog shape matches the full-rebuild
 * output.
 */
function mergeOccurrences(
  cachedCatalog: Catalog,
  walkedFunctions: Record<string, FunctionOccurrence[]>,
  closureRel: ReadonlySet<string>,
): Record<string, readonly FunctionOccurrence[]> {
  const out: Record<string, FunctionOccurrence[]> = Object.create(null) as Record<
    string,
    FunctionOccurrence[]
  >;
  // Lift cached entries for files NOT in the closure.
  for (const [name, occs] of Object.entries(cachedCatalog.functions)) {
    if (!occs) continue;
    for (const o of occs) {
      if (closureRel.has(o.filePath)) continue;
      pushOccurrence(out, name, o);
    }
  }
  // Add freshly-walked entries for closure files.
  for (const [name, occs] of Object.entries(walkedFunctions)) {
    if (!occs) continue;
    for (const o of occs) pushOccurrence(out, name, o);
  }
  return out;
}

function pushOccurrence(
  out: Record<string, FunctionOccurrence[]>,
  name: string,
  occ: FunctionOccurrence,
): void {
  let arr = out[name];
  if (!arr) {
    arr = [];
    out[name] = arr;
  }
  arr.push(occ);
}

/**
 * Stitch resolved edges into closure files; restore cached edges for
 * unchanged files. The merged catalog already has cached occurrences
 * for unchanged files; we just preserve their `calls` array.
 */
function mergeResolvedAndCachedEdges(
  merged: Catalog,
  cached: Catalog,
  edgesByOwner: ReadonlyMap<string, readonly CallEdge[]>,
  closureRel: ReadonlySet<string>,
): Record<string, readonly FunctionOccurrence[]> {
  // Build a quick index of cached occurrences by bodyHash so we can
  // look up the right cached calls without scanning the catalog
  // per-occurrence.
  const cachedByHash = new Map<string, FunctionOccurrence>();
  for (const occs of Object.values(cached.functions)) {
    if (!occs) continue;
    for (const o of occs) cachedByHash.set(o.bodyHash, o);
  }
  const out: Record<string, FunctionOccurrence[]> = Object.create(null) as Record<
    string,
    FunctionOccurrence[]
  >;
  for (const [name, occs] of Object.entries(merged.functions)) {
    if (!occs) continue;
    const arr: FunctionOccurrence[] = [];
    for (const o of occs) {
      if (closureRel.has(o.filePath)) {
        // Closure files keep their freshly-resolved edges.
        arr.push({ ...o, calls: edgesByOwner.get(o.bodyHash) ?? [] });
      } else {
        // Unchanged files: restore cached calls. The hash matched
        // because we lifted the cached occurrence into the merged
        // catalog before resolver dispatch.
        const cachedOcc = cachedByHash.get(o.bodyHash);
        arr.push({ ...o, calls: cachedOcc?.calls ?? [] });
      }
    }
    out[name] = arr;
  }
  return out;
}
