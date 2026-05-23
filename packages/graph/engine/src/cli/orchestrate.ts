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

import { resolveProjectPaths } from '@opensip-tools/core';

// Side-effect import: ensures default adapters are registered even
// when callers reach `runGraph` without going through `tool.ts`
// (e.g. orchestrator unit tests).
import '../bootstrap.js';

import { runIncremental } from '../cache/incremental.js';
import {
  classifyCatalog,
  computeFilesFingerprint,
} from '../cache/invalidate.js';
import { readCatalog } from '../cache/read.js';
import { writeCatalog } from '../cache/write.js';
import { pickAdapter } from '../lang-adapter/registry.js';
import { buildIndexes } from '../pipeline/indexes.js';
import { rules as defaultRules } from '../rules/registry.js';

import { createPressureMonitor, type PressureMonitor } from './pressure-monitor.js';

import type {
  DiscoverOutput,
  GraphLanguageAdapter,
} from '../lang-adapter/types.js';
import type { GraphStage } from '../pipeline/stages.js';
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
}

export interface RunGraphResult {
  readonly catalog: Catalog | null;
  readonly indexes: Indexes | null;
  readonly signals: readonly Signal[];
  readonly resolutionStats: ResolutionStats | null;
  readonly cacheHit: boolean;
}

// Re-export the shared stage vocabulary so external callers (Ink live
// view, tests) keep their existing import surface — `GraphStage` /
// `GRAPH_STAGES` are part of the orchestrator's public contract. The
// canonical declaration moved to `../pipeline/stages.ts` so the
// cache module can subset it without duplication.
export { GRAPH_STAGES, type GraphStage } from '../pipeline/stages.js';

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
  const paths = resolveProjectPaths(input.cwd);

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
      catalogPath: paths.graphCatalogPath,
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

    // Pass the active adapter's ruleHints to every rule. Rules that
    // don't consult them ignore the parameter; rules that do (e.g.
    // no-side-effect-path, always-throws-branch) consult adapter-
    // supplied side-effect primitives and throw-syntax shapes so
    // Python/Rust/etc. projects get language-correct heuristics
    // instead of TypeScript-shaped fallbacks. See docs/architecture/
    // 40-the-graph-loop/02-rules-and-gating.md (fidelity matrix).
    const hints = adapter.ruleHints;
    const signals: Signal[] = runStage(
      'rules',
      input.onProgress,
      monitor,
      () => {
        const collected: Signal[] = [];
        for (const rule of ruleSet) {
          const out = rule.evaluate(catalog, indexes, config, hints);
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
  readonly catalogPath: string;
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
  const cachedCatalog: Catalog | null = input.useCache
    ? readCatalog(input.catalogPath)
    : null;
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
    ? runIncremental({
        adapter: input.adapter,
        discovery: input.discovery,
        cachedCatalog,
        changedFilesAbs: verdict.changedFiles,
        runStage: (stage, fn, detailFn) =>
          runStage(stage, input.onProgress, input.monitor, fn, detailFn),
      })
    : buildAndResolveCatalog(input.adapter, input.discovery, input.onProgress, input.monitor);

  const catalog: Catalog = {
    ...built.catalog,
    filesFingerprint: computeFilesFingerprint(input.discovery.files),
  };
  if (input.useCache) {
    try {
      writeCatalog(input.catalogPath, catalog);
    } catch {
      // Cache write failure is non-fatal — already logged.
    }
  }
  return { catalog, cacheHit: false, resolutionStats: built.resolutionStats };
}


