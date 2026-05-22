/**
 * Pipeline orchestrator — threads stages 0–5 together.
 *
 * The single module that wires adapter outputs into the rule pipeline.
 * Per spec §5, the orchestrator is straight-line code; every
 * interesting decision happens inside one of the stages.
 *
 * PR 3 of plan docs/plans/10-graph-language-pluggability.md: this
 * module no longer imports `'typescript'` directly. The orchestrator
 * looks up an adapter from the lang-adapter registry and routes
 * file-discovery / parse / walk / resolution through its method
 * surface. The TypeScript adapter is the only one registered today;
 * future adapters slot in by calling `registerAdapter` at bootstrap.
 */

import { relative, sep } from 'node:path';

import { logger } from '@opensip-tools/core';


// Side-effect import: ensures default adapters are registered even
// when callers reach `runGraph` without going through `tool.ts`
// (e.g. orchestrator unit tests).
import '../bootstrap.js';

import {
  classifyCatalog,
  computeFilesFingerprint,
} from '../cache/invalidate.js';
import { pickAdapter } from '../lang-adapter/registry.js';
import { CatalogRepo } from '../persistence/catalog-repo.js';
import { buildIndexes } from '../pipeline/indexes.js';
import { rules as defaultRules } from '../rules/registry.js';

import { createPressureMonitor, type PressureMonitor } from './pressure-monitor.js';

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
  GraphConfig,
  Indexes,
  ResolutionStats,
  Rule,
} from '../types.js';
import type { Signal } from '@opensip-tools/core';
import type { DataStore } from '@opensip-tools/datastore';

export interface RunGraphInput {
  readonly cwd: string;
  readonly noCache?: boolean;
  readonly config?: GraphConfig;
  /** Override the rule set (tests, custom invocations). */
  readonly rules?: readonly Rule[];
  /** Override the adapter's config-file path (e.g. tsconfig.json). */
  readonly tsConfigPath?: string;
  /**
   * Optional structured progress callback. The orchestrator emits one
   * `stage-start` + one of `stage-done` / `stage-cached` per pipeline
   * stage (discover, parse, walk, resolve, index, rules). Used by the
   * Ink live view; non-interactive callers (json/gate/report) leave it
   * undefined.
   */
  readonly onProgress?: GraphProgressCallback;
  /**
   * Datastore for catalog persistence. v2: replaces the v1
   * `paths.graphCatalogPath` JSON file. Optional so legacy callers
   * (acceptance tests pre-Phase-3) can still drive the orchestrator
   * without a DataStore — the catalog will be rebuilt every run.
   */
  readonly datastore?: DataStore;
}

export interface RunGraphResult {
  readonly catalog: Catalog | null;
  readonly indexes: Indexes | null;
  readonly signals: readonly Signal[];
  readonly resolutionStats: ResolutionStats | null;
  readonly cacheHit: boolean;
}

/** Pipeline stage identity, in canonical order. */
export type GraphStage =
  | 'discover'
  | 'parse'
  | 'walk'
  | 'resolve'
  | 'index'
  | 'rules';

/** Canonical stage order — consumed by the live view to render the checklist. */
export const GRAPH_STAGES: readonly GraphStage[] = [
  'discover',
  'parse',
  'walk',
  'resolve',
  'index',
  'rules',
];

/**
 * Structured progress event. `stage-cached` fires for parse/walk/resolve
 * when the on-disk catalog cache satisfies the run; the view renders
 * those stages as "(cached)" instead of running them.
 */
export interface GraphProgressEvent {
  readonly type: 'stage-start' | 'stage-done' | 'stage-cached';
  readonly stage: GraphStage;
  readonly durationMs?: number;
  readonly detail?: string;
}

export type GraphProgressCallback = (event: GraphProgressEvent) => void;

function runStage<T>(
  stage: GraphStage,
  onProgress: GraphProgressCallback | undefined,
  monitor: PressureMonitor | undefined,
  fn: () => T,
  detailFn?: (result: T) => string | undefined,
): T {
  monitor?.setStage(stage);
  // Sample BEFORE the stage starts. The previous stage may have left
  // the heap near the threshold; bail out before doing more work that
  // would push us over and forfeit the ability to report cleanly.
  monitor?.check();
  onProgress?.({ type: 'stage-start', stage });
  const startedAt = Date.now();
  const result = fn();
  const durationMs = Date.now() - startedAt;
  onProgress?.({
    type: 'stage-done',
    stage,
    durationMs,
    detail: detailFn?.(result),
  });
  return result;
}

/**
 * Run the pipeline end-to-end. Each stage runs in isolation; the
 * orchestrator wires their outputs together and consults the cache
 * before redoing stages 1+2.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- async surface for future cache I/O
export async function runGraph(input: RunGraphInput): Promise<RunGraphResult> {
  const config: GraphConfig = input.config ?? {};
  const ruleSet: readonly Rule[] = input.rules ?? defaultRules;
  const catalogRepo = input.datastore ? new CatalogRepo(input.datastore) : null;

  const monitor = createPressureMonitor();
  try {
    const adapter = pickAdapter(input.cwd);
    const discovery = runStage(
      'discover',
      input.onProgress,
      monitor,
      () => adapter.discoverFiles({
        cwd: input.cwd,
        configPathOverride: input.tsConfigPath,
      }),
      (d) => `${String(d.files.length)} files`,
    );

    const { catalog, cacheHit, resolutionStats } = obtainCatalog({
      adapter,
      discovery,
      catalogRepo,
      useCache: input.noCache !== true,
      onProgress: input.onProgress,
      monitor,
    });

    const indexes: Indexes = runStage(
      'index',
      input.onProgress,
      monitor,
      () => buildIndexes(catalog),
    );

    const signals: Signal[] = runStage(
      'rules',
      input.onProgress,
      monitor,
      () => {
        const collected: Signal[] = [];
        for (const rule of ruleSet) {
          const out = rule.evaluate(catalog, indexes, config);
          collected.push(...out);
        }
        return collected;
      },
      (sigs) => `${String(ruleSet.length)} rule(s), ${String(sigs.length)} signal(s)`,
    );

    return {
      catalog,
      indexes,
      signals,
      resolutionStats,
      cacheHit,
    };
  } finally {
    monitor.dispose();
  }
}

/**
 * Run Stage 1 + Stage 2 and return only the catalog and resolution
 * stats. The parsed project is created inside this function and does
 * not escape — once edge resolution returns, it is unreachable from
 * any caller, so V8 can reclaim the bound AST before Stage 3
 * (`buildIndexes`) and the cache write run.
 */
function buildAndResolveCatalog(
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

interface ObtainCatalogInput {
  readonly adapter: GraphLanguageAdapter;
  readonly discovery: DiscoverOutput;
  readonly catalogRepo: CatalogRepo | null;
  readonly useCache: boolean;
  readonly onProgress?: GraphProgressCallback;
  readonly monitor?: PressureMonitor;
}

interface ObtainCatalogOutput {
  readonly catalog: Catalog;
  readonly cacheHit: boolean;
  readonly resolutionStats: ResolutionStats | null;
}

/**
 * Resolve the catalog for this run by consulting the on-disk cache,
 * dispatching to the right rebuild path (full vs Wave 4 incremental
 * vs cache hit) per `classifyCatalog`'s verdict.
 */
function obtainCatalog(input: ObtainCatalogInput): ObtainCatalogOutput {
  const cachedCatalog: Catalog | null =
    input.useCache && input.catalogRepo ? input.catalogRepo.loadFullCatalog() : null;
  const currentCacheKey = input.adapter.cacheKey({
    projectDirAbs: input.discovery.projectDirAbs,
    configPathAbs: input.discovery.configPathAbs,
    compilerOptions: input.discovery.compilerOptions,
  });
  const verdict = cachedCatalog
    ? classifyCatalog(cachedCatalog, {
        currentLanguage: input.adapter.id,
        currentCacheKey,
        currentFiles: input.discovery.files,
      })
    : ({ kind: 'invalid', reason: 'no-cache' } as const);

  if (verdict.kind === 'valid' && cachedCatalog) {
    // Parse/walk/resolve are skipped wholesale. Tell the view so it can
    // render those stages as "(cached)" rather than leaving them pending.
    for (const stage of ['parse', 'walk', 'resolve'] as const) {
      input.onProgress?.({ type: 'stage-cached', stage });
    }
    return { catalog: cachedCatalog, cacheHit: true, resolutionStats: null };
  }
  const built = verdict.kind === 'incremental' && cachedCatalog
    ? buildAndResolveCatalogIncremental(
        input.adapter,
        input.discovery,
        cachedCatalog,
        verdict.changedFiles,
        input.onProgress,
        input.monitor,
      )
    : buildAndResolveCatalog(input.adapter, input.discovery, input.onProgress, input.monitor);

  const catalog: Catalog = {
    ...built.catalog,
    filesFingerprint: computeFilesFingerprint(input.discovery.files),
  };
  if (input.useCache && input.catalogRepo) {
    try {
      input.catalogRepo.replaceAll(catalog);
    } catch {
      // Cache write failure is non-fatal — already logged.
    }
  }
  return { catalog, cacheHit: false, resolutionStats: built.resolutionStats };
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
function buildAndResolveCatalogIncremental(
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
  /* v8 ignore next 3 */
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

  /* v8 ignore start */
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
  /* v8 ignore stop */
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

