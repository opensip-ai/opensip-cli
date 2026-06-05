// @fitness-ignore-file detached-promises -- stage hooks (registry registration, logger.info) are synchronous; orchestrator threads them inside an async pipeline
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
 * future adapters slot in via `currentAdapterRegistry().register(...)`
 * at bootstrap.
 *
 * Stage decomposition (siblings under `./orchestrate/`):
 *   - `catalog-builder.ts`    — full + incremental rebuild paths
 *   - `cache-orchestrator.ts` — cache hit/miss/incremental routing
 *   - `incremental-merge.ts`  — Wave-4 closure expansion + edge merge
 * This file keeps `runGraph()` (entry), `runStage()` (the
 * progress/pressure-monitor wrapper threaded into siblings), and the
 * public type surface.
 */

import { withSpanAsync, type Signal } from '@opensip-tools/core';

import { currentAdapterRegistry, pickAdapter } from '../lang-adapter/registry.js';
import { CatalogRepo } from '../persistence/catalog-repo.js';
import { unionFeatureDeps } from '../pipeline/feature-deps.js';
import {
  buildFeatures,
  isPersistedFeaturesEmpty,
  toPersistedFeatures,
} from '../pipeline/features.js';
import { buildIndexes } from '../pipeline/indexes.js';
import { currentRules } from '../rules/registry.js';

import { GRAPH_TRACER } from './graph-tracer.js';
import { obtainCatalog } from './orchestrate/cache-orchestrator.js';
import { createPressureMonitor } from './pressure-monitor.js';

import type {
  Catalog,
  FeatureColumn,
  FeatureTable,
  GraphConfig,
  Indexes,
  ResolutionMode,
  ResolutionStats,
  Rule,
} from '../types.js';
import type { RunStageArgs } from './orchestrate/catalog-builder.js';
import type { GraphProgressCallback } from './orchestrate/types.js';
import type { DataStore } from '@opensip-tools/datastore';

// Re-export the orchestration types so existing callers (the engine's
// public `index.ts` barrel, the Ink live view, downstream tooling)
// continue to import them from `./orchestrate.js`. The canonical
// declarations now live in `./orchestrate/types.ts` — a leaf module
// that the orchestrator's helpers (`cache-orchestrator`,
// `catalog-builder`) also import from. The split breaks the
// `orchestrate → cache-orchestrator → catalog-builder → orchestrate`
// file-level cycle the `circular-import-detection` check flagged.
export { GRAPH_STAGES } from './orchestrate/types.js';
export type {
  GraphProgressCallback,
  GraphProgressEvent,
  GraphStage,
} from './orchestrate/types.js';

// The sharded build is an orchestration mode; expose it from the same
// orchestration facade so dispatchers reach both `runGraph` and
// `runShardedGraph` through one entry point.
export { runShardedGraph } from './orchestrate/sharded-graph.js';
export { loadGraphConfig } from './graph-config.js';
export type { RunShardedInput, RunShardedResult } from './orchestrate/sharded-graph.js';

/** Input bundle for {@link runGraph}: project scope, optional overrides, and progress callback. */
export interface RunGraphInput {
  readonly cwd: string;
  readonly noCache?: boolean;
  readonly config?: GraphConfig;
  /** Override the rule set (tests, custom invocations). */
  readonly rules?: readonly Rule[];
  /** Override the adapter's config-file path (e.g. tsconfig.json). */
  readonly tsConfigPath?: string;
  /**
   * Optional canonical adapter id (`typescript`, `python`, `rust`,
   * etc.). When set, bypasses `pickAdapter`'s file-extension dominance
   * heuristic and selects the named adapter directly. The graph CLI
   * surfaces this via the `--language` flag.
   */
  readonly language?: string;
  /**
   * Edge resolution tier. `'exact'` (default, or absent) runs the
   * semantic type-checker-backed resolvers; `'fast'` runs the syntactic
   * resolver with no type checker. Normalized to `'exact'` at the
   * orchestrator boundary and folded into the cacheKey so the two tiers
   * never collide in the catalog cache. Surfaced by the `--resolution`
   * CLI flag.
   */
  readonly resolution?: ResolutionMode;
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
  /**
   * Columns to materialize into the persisted catalog for the decoupled
   * dashboard (ADR-0006). Absent/empty ⇒ no features persisted. The standard
   * interactive run requests `['blast','scc','packageCoupling']`; export-only
   * paths omit it. Unioned with every enabled rule's `featureDeps` to decide
   * what the features stage computes.
   */
  readonly emitFeatures?: readonly FeatureColumn[];
}

/** Output of {@link runGraph}: catalog, indexes, signals, resolution stats, and cache state. */
export interface RunGraphResult {
  readonly catalog: Catalog | null;
  readonly indexes: Indexes | null;
  readonly signals: readonly Signal[];
  readonly resolutionStats: ResolutionStats | null;
  readonly cacheHit: boolean;
  /** The engine-computed feature table for this run (only the requested
   *  columns are populated). `null` only on a path that produced no catalog. */
  readonly features: FeatureTable | null;
}

/**
 * Yield to the event loop once (a macrotask hop). Lets the in-process live view
 * paint between/within stages so its spinner animates instead of freezing while
 * a synchronous stage runs (ADR-0016, cooperative-yield). A no-op for cost in
 * non-interactive runs (one `setImmediate` per stage is negligible).
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function runStage<T>(args: RunStageArgs<T>): Promise<T> {
  const { stage, onProgress, monitor, fn, detailFn, attrsFn } = args;
  monitor?.setStage(stage);
  // Sample BEFORE the stage starts. The previous stage may have left
  // the heap near the threshold; bail out before doing more work that
  // would push us over and forfeit the ability to report cleanly.
  monitor?.check();
  onProgress?.({ type: 'stage-start', stage });
  // Yield so the live view paints the stage-start (the spinner moves to this
  // row) before a synchronous stage blocks the loop. The cooperative resolve
  // stage yields again internally, so its spinner keeps ticking throughout.
  await yieldToEventLoop();
  const startedAt = Date.now();
  // Emit one span per stage. withSpanAsync keeps the span open across the
  // (possibly async) stage work and is a no-op when no SDK is registered.
  const result = await withSpanAsync(GRAPH_TRACER, `opensip_tools.graph.${stage}`, async (span) => {
    const out = await fn();
    if (attrsFn) span.setAttributes(attrsFn(out));
    return out;
  }, { 'opensip_tools.graph.stage': stage });
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
 
export async function runGraph(input: RunGraphInput): Promise<RunGraphResult> {
  const config: GraphConfig = input.config ?? {};
  const ruleSet: readonly Rule[] = input.rules ?? currentRules();
  const requestedColumns = unionFeatureDeps(ruleSet, input.emitFeatures);
  const catalogRepo = input.datastore ? new CatalogRepo(input.datastore) : null;
  // Normalize the tier once at the boundary; absence ⇒ exact (historical).
  const resolutionMode: ResolutionMode = input.resolution ?? 'exact';

  const monitor = createPressureMonitor();
  try {
    const adapter = pickAdapterFor(input);
    const discovery = await runStage({
      stage: 'discover',
      onProgress: input.onProgress,
      monitor,
      fn: () => adapter.discoverFiles({
        cwd: input.cwd,
        configPathOverride: input.tsConfigPath,
      }),
      detailFn: (d) => `${String(d.files.length)} files`,
      attrsFn: (d) => ({ 'opensip_tools.graph.file_count': d.files.length }),
    });

    const { catalog, cacheHit, resolutionStats } = await obtainCatalog({
      runStage,
      adapter,
      discovery,
      catalogRepo,
      useCache: input.noCache !== true,
      resolutionMode,
      projectRoot: input.cwd,
      onProgress: input.onProgress,
      monitor,
    });

    const indexes: Indexes = await runStage({
      stage: 'index',
      onProgress: input.onProgress,
      monitor,
      fn: () => buildIndexes(catalog),
      // cacheHit is resolved by obtainCatalog (parse/walk/resolve) above, so it
      // is known by the time the index stage runs. Surfacing it here gives the
      // consumer a low-cardinality flag for "was this an incremental/cached run."
      attrsFn: () => ({ 'opensip_tools.graph.cache_hit': cacheHit }),
    });

    // Stage 3.5 — feature derivation. Runs after index / before rules so rules
    // consume the columns as a plain view (ADR-0006). Computes only the union
    // of the rule set's featureDeps + the caller's emitFeatures.
    const features: FeatureTable = await runStage({
      stage: 'features',
      onProgress: input.onProgress,
      monitor,
      fn: () => buildFeatures(catalog, indexes, config, requestedColumns),
      attrsFn: (f) => ({
        'opensip_tools.graph.feature_columns': requestedColumns.length,
        'opensip_tools.graph.scc_count': f.scc.length,
      }),
    });

    const signals: Signal[] = await runStage({
      stage: 'rules',
      onProgress: input.onProgress,
      monitor,
      fn: () => {
        const collected: Signal[] = [];
        for (const rule of ruleSet) {
          // Thread the active adapter's RuleHints so non-TypeScript
          // languages get their own side-effect primitives, throw
          // syntax, generated-file globs, and isTestFile predicate.
          // Without this, rules that consult `hints` silently fall
          // back to TypeScript-shaped regex on every other language.
          // The 5th arg is the engine-computed feature table (Plan C).
          const out = rule.evaluate(catalog, indexes, config, adapter.ruleHints, features);
          collected.push(...out);
        }
        return collected;
      },
      detailFn: (sigs) => `${String(ruleSet.length)} rule(s), ${String(sigs.length)} signal(s)`,
      attrsFn: (sigs) => ({
        'opensip_tools.graph.rule_count': ruleSet.length,
        'opensip_tools.graph.signal_count': sigs.length,
      }),
    });

    // Materialize the requested dashboard columns into the persisted catalog
    // (ADR-0006). obtainCatalog already wrote the feature-LESS catalog; a
    // second persist attaches features ONLY when columns were requested and
    // the projection is non-empty (a lean default-run persists no blob).
    const persistedFeatures = toPersistedFeatures(features, requestedColumns);
    const persisted = isPersistedFeaturesEmpty(persistedFeatures) ? undefined : persistedFeatures;
    if (persisted && catalogRepo) {
      try {
        catalogRepo.replaceAll({ ...catalog, features: persisted });
      } catch {
        /* v8 ignore next */
        // @swallow-ok feature materialization is best-effort: CatalogRepo.replaceAll
        // already logs the failure via its own logger, and the run returns the
        // catalog (with in-memory features) regardless — re-logging here would
        // only double-report the same error.
      }
    }

    return {
      catalog: persisted ? { ...catalog, features: persisted } : catalog,
      indexes,
      signals,
      resolutionStats,
      cacheHit,
      features,
    };
  } finally {
    monitor.dispose();
  }
}

/**
 * Pick a graph language adapter for the run. When `language` is set,
 * look up that adapter directly via the registry; otherwise fall back
 * to the file-extension dominance heuristic in `pickAdapter`. If the
 * named language isn't registered, fall through to `pickAdapter` so
 * the caller's CLI gets a clearer error path (D14 / "no adapter
 * registered").
 */
function pickAdapterFor(input: RunGraphInput): ReturnType<typeof pickAdapter> {
  if (typeof input.language === 'string' && input.language.length > 0) {
    const entry = currentAdapterRegistry().getById(input.language);
    if (entry) return entry.adapter;
  }
  return pickAdapter(input.cwd);
}
