import { ConfigurationError, type Signal, type ToolCliContext } from '@opensip-cli/core';

import {
  type FinalizedSignals,
  assertFinalizedAcrossBoundary,
  finalizeGraphSignals,
} from './apply-suppressions.js';
import { DASHBOARD_FEATURE_COLUMNS } from './graph-feature-columns.js';
import { countFiles } from './graph-report.js';
import { loadGraphConfig, runGraph, type RunGraphResult } from './orchestrate.js';
import { positionalPathLabel } from './positional-paths.js';
import { type GraphProfileBuilder } from './profile.js';

import type { GraphCommandOptions } from './graph-options.js';
import type { GraphRunOutcome } from './graph-run-outcome.js';
import type { Rule } from '../types.js';
import type { DataStore } from '@opensip-cli/datastore';

type DeliverGraphResult = (
  opts: GraphCommandOptions,
  result: RunGraphResult,
  cli: ToolCliContext,
  startedAt: string,
  finalized: FinalizedSignals,
) => Promise<GraphRunOutcome | undefined>;

/**
 * Ambient run context for multi-path graph fan-out. The main command handler
 * owns recipe resolution, profiling setup, and the branded delivery function;
 * this module owns per-path exact engine execution and aggregation.
 */
export interface MultiPathContext {
  readonly opts: GraphCommandOptions;
  readonly cli: ToolCliContext;
  readonly rules: readonly Rule[];
  readonly startedAt: string;
  readonly profile?: GraphProfileBuilder;
  readonly deliverGraphResult: DeliverGraphResult;
}

export async function executeMultiPathGraph(
  ctx: MultiPathContext,
  paths: readonly string[],
): Promise<GraphRunOutcome | undefined> {
  const { opts, cli, rules, startedAt, profile, deliverGraphResult } = ctx;
  const allSignals: Signal[] = [];
  let combinedFiles = 0;
  let totalSuppressed = 0;
  let lastResult: RunGraphResult | null = null;
  const config = loadGraphConfig(opts.cwd);
  for (const p of paths) {
    const profileRun = profile?.startRun({
      label: positionalPathLabel(p, opts.cwd),
      cwd: p,
      mode: 'single-process',
    });
    const r = await runGraph({
      cwd: p,
      noCache: opts.noCache,
      resolution: opts.resolution,
      language: opts.language,
      config,
      rules,
      datastore: cli.scope.datastore() as DataStore | undefined,
      emitFeatures: DASHBOARD_FEATURE_COLUMNS,
      onProgress: profileRun?.onProgress,
    });
    profileRun?.finish(r);
    lastResult = r;
    // Each path's signals are relative to that path's root, so waive them
    // against the same root before aggregating. The aggregate is re-branded
    // below; it is not suppressed a second time under an ambiguous root.
    const finalized = await finalizeGraphSignals(r.signals, p);
    totalSuppressed += finalized.suppressedCount;
    allSignals.push(...finalized.signals);
    if (r.catalog !== null) combinedFiles += countFiles(r.catalog);
  }

  if (typeof opts.language === 'string' && opts.language.length > 0 && combinedFiles === 0) {
    throw new ConfigurationError(
      `--language ${opts.language} matched 0 files under ${paths.map((p) => positionalPathLabel(p, opts.cwd)).join(', ')}; check the flag or paths.`,
    );
  }
  /* v8 ignore next */
  if (lastResult === null) return undefined;
  const combined: RunGraphResult = {
    catalog: lastResult.catalog,
    indexes: lastResult.indexes,
    signals: allSignals,
    resolutionStats: lastResult.resolutionStats,
    cacheHit: lastResult.cacheHit,
    features: lastResult.features,
  };
  const finalizedAggregate = assertFinalizedAcrossBoundary(allSignals, totalSuppressed);
  return await deliverGraphResult(opts, combined, cli, startedAt, finalizedAggregate);
}
