import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { buildSignalEnvelope } from '@opensip-cli/contracts';
import { filterSignalsBySuppressions, isErrorSignal, yieldToEventLoop } from '@opensip-cli/core';

import { yagniFingerprintStrategy } from '../baseline-strategy.js';
import { YAGNI_DETECTORS } from '../detectors/registry.js';
import { YAGNI_LAYOUT_KEY } from '../identity.js';
import { buildYagniSessionPayload } from '../persistence/session-payload.js';
import {
  buildYagniRunSummary,
  filterByMinConfidence,
  filterByReductionCategories,
  sortYagniSignals,
} from '../scoring/confidence.js';

import type { SkippedDetector, YagniDetector } from '../detectors/types.js';
import type { YagniConfig } from '../types/yagni-config.js';
import type { YagniConfidence } from '../types/yagni-metadata.js';
import type { SignalEnvelope, UnitResult } from '@opensip-cli/contracts';
import type { Signal, ToolCliContext } from '@opensip-cli/core';

/** Runtime options for one YAGNI detector pass. */
export interface ExecuteYagniOptions {
  readonly cwd: string;
  readonly config?: YagniConfig;
  readonly minConfidence?: YagniConfidence;
  readonly detectors?: readonly string[];
  readonly categories?: readonly string[];
  readonly includeTests?: boolean;
  readonly pathRoots?: readonly string[];
  /** Aggregate count progress (pool-shape live view). */
  readonly onProgress?: (completed: number, total: number) => void;
  /** Per-detector lifecycle, for a phases-shape live view that names each detector. */
  readonly onDetectorStart?: (slug: string) => void;
  readonly onDetectorDone?: (slug: string, durationMs: number) => void;
  /** The detectors `planDetectors` excluded (filtered out or disabled), emitted once. */
  readonly onDetectorsSkipped?: (slugs: readonly string[]) => void;
}

/** Envelope plus session payload returned to the host command runner. */
export interface ExecuteYagniResult {
  readonly envelope: SignalEnvelope;
  readonly session: {
    readonly tool: 'yagni';
    readonly cwd: string;
    readonly score: number;
    readonly passed: boolean;
    readonly payload: ReturnType<typeof buildYagniSessionPayload>;
  };
}

const YAGNI_SUPPRESSION_KEYWORDS = {
  file: '@yagni-ignore-file',
  nextLine: '@yagni-ignore-next-line',
} as const;

function isDisabled(detector: YagniDetector, config: YagniConfig): boolean {
  const disabled = config.disabledDetectors ?? [];
  return disabled.includes(detector.id) || disabled.includes(detector.slug);
}

function matchesDetectorFilter(detector: YagniDetector, filter: readonly string[]): boolean {
  if (filter.length === 0) return true;
  return filter.some(
    (slug) =>
      slug === detector.id ||
      slug === detector.slug ||
      slug === detector.slug.replace(/^yagni:/, ''),
  );
}

function planDetectors(
  detectors: readonly YagniDetector[],
  config: YagniConfig,
  detectorFilter: readonly string[],
): {
  readonly run: readonly YagniDetector[];
  readonly skipped: readonly SkippedDetector[];
} {
  const run: YagniDetector[] = [];
  const skipped: SkippedDetector[] = [];

  for (const detector of detectors) {
    if (!matchesDetectorFilter(detector, detectorFilter)) continue;
    if (isDisabled(detector, config)) {
      skipped.push({
        id: detector.id,
        slug: detector.slug,
        reason: 'disabled',
      });
      continue;
    }
    run.push(detector);
  }

  return { run, skipped };
}

function yagniDirectiveId(signal: Signal): string {
  return signal.ruleId.startsWith('yagni:') ? signal.ruleId.slice('yagni:'.length) : signal.ruleId;
}

function sourcePath(cwd: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : join(cwd, filePath);
}

async function filterYagniSuppressions(
  cwd: string,
  signals: readonly Signal[],
): Promise<{
  readonly kept: readonly Signal[];
  readonly suppressed: readonly Signal[];
}> {
  const { kept, suppressed } = await filterSignalsBySuppressions({
    signals,
    keywords: YAGNI_SUPPRESSION_KEYWORDS,
    readFile: (filePath) => readFile(sourcePath(cwd, filePath), 'utf8'),
    ruleIdOf: yagniDirectiveId,
  });
  return {
    kept,
    suppressed: suppressed.map((match) => match.signal),
  };
}

function signalsBySource(signals: readonly Signal[]): ReadonlyMap<string, readonly Signal[]> {
  const bySource = new Map<string, Signal[]>();
  for (const signal of signals) {
    const bucket = bySource.get(signal.source);
    if (bucket) bucket.push(signal);
    else bySource.set(signal.source, [signal]);
  }
  return bySource;
}

function suppressionAdjustedUnits(
  units: readonly UnitResult[],
  keptSignals: readonly Signal[],
  suppressedSignals: readonly Signal[],
): readonly UnitResult[] {
  const keptBySource = signalsBySource(keptSignals);
  const suppressedBySource = signalsBySource(suppressedSignals);
  return units.map((unit) => {
    const signals = keptBySource.get(unit.slug) ?? [];
    const ignoredCount = suppressedBySource.get(unit.slug)?.length ?? 0;
    return {
      ...unit,
      passed: unit.error === undefined && signals.every((s) => !isErrorSignal(s)),
      violationCount: signals.length,
      ...(ignoredCount === 0 ? {} : { ignoredCount }),
    };
  });
}

/**
 * Run the selected YAGNI detectors and build the persisted signal envelope.
 *
 * `_cli` is retained in the signature for API stability and the Track 2 reduction
 * coordinator (which will re-acquire graph/fitness evidence through it); the
 * current detector-only path does not use it.
 */
export async function executeYagni(
  opts: ExecuteYagniOptions,
  _cli: ToolCliContext,
  detectors: readonly YagniDetector[] = YAGNI_DETECTORS,
): Promise<ExecuteYagniResult> {
  const config = opts.config ?? {};
  const includeTests = opts.includeTests ?? config.includeTests ?? false;
  const minConfidence = opts.minConfidence ?? config.defaultMinConfidence ?? 'medium';

  const { run, skipped } = planDetectors(detectors, config, opts.detectors ?? []);
  const allSignals: Signal[] = [];
  const units: UnitResult[] = [];
  const total = run.length;
  opts.onProgress?.(0, total);
  if (skipped.length > 0) opts.onDetectorsSkipped?.(skipped.map((s) => s.slug));

  for (const detector of run) {
    const started = Date.now();
    opts.onDetectorStart?.(detector.slug);
    // Yield so a phases live view paints the running spinner + live elapsed on
    // this detector before a fast/synchronous detector blocks the event loop —
    // mirrors graph's runStage, which yields right after stage-start so the
    // spinner moves to the active row instead of jumping straight to done.
    if (opts.onDetectorStart) await yieldToEventLoop();
    try {
      const result = await detector.run({
        cwd: opts.cwd,
        config,
        graphCatalog: null,
        includeTests,
        ...(opts.pathRoots === undefined ? {} : { pathRoots: opts.pathRoots }),
      });
      const filtered = filterByMinConfidence(result.signals, minConfidence);
      allSignals.push(...filtered);
      const violationCount = filtered.length;
      units.push({
        slug: detector.slug,
        passed: violationCount === 0 || filtered.every((s) => !isErrorSignal(s)),
        violationCount,
        durationMs: result.durationMs || Date.now() - started,
      });
    } catch (error) {
      units.push({
        slug: detector.slug,
        passed: false,
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    opts.onDetectorDone?.(detector.slug, units.at(-1)?.durationMs ?? Date.now() - started);
    opts.onProgress?.(units.length, total);
  }

  const categoryFiltered = filterByReductionCategories(allSignals, opts.categories ?? []);
  const { kept, suppressed } = await filterYagniSuppressions(opts.cwd, categoryFiltered);
  const sortedSignals = sortYagniSignals(kept);
  const finalUnits = suppressionAdjustedUnits(units, sortedSignals, suppressed);

  const runId = randomUUID();
  const createdAt = new Date().toISOString();
  const policy = {
    failOnErrors: config.failOnErrors ?? 0,
    failOnWarnings: config.failOnWarnings ?? 0,
  };
  const envelope = buildSignalEnvelope({
    tool: 'yagni',
    runId,
    createdAt,
    units: finalUnits,
    signals: sortedSignals,
    policy,
    runFaulted: finalUnits.some((u) => u.error !== undefined),
    fingerprintStrategy: yagniFingerprintStrategy,
  });

  const yagniSummary = buildYagniRunSummary(envelope.signals, skipped);
  const sessionPayload = buildYagniSessionPayload(envelope, skipped, yagniSummary);

  return {
    envelope,
    session: {
      tool: YAGNI_LAYOUT_KEY,
      cwd: opts.cwd,
      score: envelope.verdict.score,
      passed: true,
      payload: sessionPayload,
    },
  };
}
