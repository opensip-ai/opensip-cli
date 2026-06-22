import { randomUUID } from 'node:crypto';

import { buildSignalEnvelope } from '@opensip-cli/contracts';
import { isErrorSignal } from '@opensip-cli/core';

import { yagniFingerprintStrategy } from '../baseline-strategy.js';
import { YAGNI_DETECTORS } from '../detectors/registry.js';
import { resolveGraphEvidence } from '../evidence/graph-evidence.js';
import { buildYagniSessionPayload } from '../persistence/session-payload.js';
import {
  buildYagniRunSummary,
  filterByMinConfidence,
  filterByReductionCategories,
  sortYagniSignals,
} from '../scoring/confidence.js';

import type { SkippedDetector, YagniDetector } from '../detectors/types.js';
import type { YagniConfig, YagniGraphMode } from '../types/yagni-config.js';
import type { YagniConfidence } from '../types/yagni-metadata.js';
import type { SignalEnvelope, UnitResult } from '@opensip-cli/contracts';
import type { ToolCliContext } from '@opensip-cli/core';

/** Runtime options for one YAGNI detector pass. */
export interface ExecuteYagniOptions {
  readonly cwd: string;
  readonly config?: YagniConfig;
  readonly graphMode?: YagniGraphMode;
  readonly minConfidence?: YagniConfidence;
  readonly detectors?: readonly string[];
  readonly categories?: readonly string[];
  readonly includeTests?: boolean;
  readonly pathRoots?: readonly string[];
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
  graphAvailable: boolean,
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
    if (detector.requiresGraph && !graphAvailable) {
      skipped.push({
        id: detector.id,
        slug: detector.slug,
        reason: 'graph-required',
        detail: 'graph evidence unavailable',
      });
      continue;
    }
    run.push(detector);
  }

  return { run, skipped };
}

/** Run the selected YAGNI detectors and build the persisted signal envelope. */
export async function executeYagni(
  opts: ExecuteYagniOptions,
  cli: ToolCliContext,
  detectors: readonly YagniDetector[] = YAGNI_DETECTORS,
): Promise<ExecuteYagniResult> {
  const config = opts.config ?? {};
  const graphMode = opts.graphMode ?? config.graphMode ?? 'auto';
  const graphEvidence = await resolveGraphEvidence(opts.cwd, graphMode, cli);
  const graphAvailable = graphEvidence.catalog !== null;
  const includeTests = opts.includeTests ?? config.includeTests ?? false;
  const minConfidence = opts.minConfidence ?? config.defaultMinConfidence ?? 'medium';

  const { run, skipped } = planDetectors(detectors, config, graphAvailable, opts.detectors ?? []);
  const allSignals = [];
  const units: UnitResult[] = [];

  for (const detector of run) {
    const started = Date.now();
    try {
      const result = await detector.run({
        cwd: opts.cwd,
        config,
        graphCatalog: graphEvidence.catalog,
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
  }

  const categoryFiltered = filterByReductionCategories(allSignals, opts.categories ?? []);
  const sortedSignals = sortYagniSignals(categoryFiltered);

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
    units,
    signals: sortedSignals,
    policy,
    runFaulted: units.some((u) => u.error !== undefined),
    fingerprintStrategy: yagniFingerprintStrategy,
  });

  const yagniSummary = buildYagniRunSummary(envelope.signals, graphEvidence.mode, skipped);
  const sessionPayload = buildYagniSessionPayload(envelope, skipped, {
    graphMode: graphEvidence.mode,
    graphBuilt: graphEvidence.built,
    graphDetail: graphEvidence.detail,
    yagniSummary,
  });

  return {
    envelope,
    session: {
      tool: 'yagni',
      cwd: opts.cwd,
      score: envelope.verdict.score,
      passed: true,
      payload: sessionPayload,
    },
  };
}
