import { randomUUID } from 'node:crypto';

import { buildSignalEnvelope } from '@opensip-cli/contracts';
import { isErrorSignal } from '@opensip-cli/core';

import { YAGNI_DETECTORS } from '../detectors/registry.js';
import { resolveGraphEvidence } from '../evidence/graph-evidence.js';
import { filterByMinConfidence } from '../scoring/confidence.js';
import { buildYagniSessionPayload } from '../persistence/session-payload.js';

import type { SkippedDetector, YagniDetector } from '../detectors/types.js';
import type { YagniConfig, YagniGraphMode } from '../types/yagni-config.js';
import type { SignalEnvelope, UnitResult } from '@opensip-cli/contracts';
import type { ToolCliContext } from '@opensip-cli/core';

export interface ExecuteYagniOptions {
  readonly cwd: string;
  readonly config?: YagniConfig;
  readonly graphMode?: YagniGraphMode;
}

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

function planDetectors(
  detectors: readonly YagniDetector[],
  config: YagniConfig,
  graphAvailable: boolean,
): { readonly run: readonly YagniDetector[]; readonly skipped: readonly SkippedDetector[] } {
  const run: YagniDetector[] = [];
  const skipped: SkippedDetector[] = [];

  for (const detector of detectors) {
    if (isDisabled(detector, config)) {
      skipped.push({ id: detector.id, slug: detector.slug, reason: 'disabled' });
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

export async function executeYagni(
  opts: ExecuteYagniOptions,
  cli: ToolCliContext,
  detectors: readonly YagniDetector[] = YAGNI_DETECTORS,
): Promise<ExecuteYagniResult> {
  const config = opts.config ?? {};
  const graphMode = opts.graphMode ?? config.graphMode ?? 'auto';
  const graphEvidence = await resolveGraphEvidence(opts.cwd, graphMode, cli);
  const graphAvailable = graphEvidence.catalog !== null;

  const { run, skipped } = planDetectors(detectors, config, graphAvailable);
  const allSignals = [];
  const units: UnitResult[] = [];

  for (const detector of run) {
    const started = Date.now();
    try {
      const result = await detector.run({
        cwd: opts.cwd,
        config,
        graphCatalog: graphEvidence.catalog,
        includeTests: config.includeTests ?? false,
      });
      const filtered = filterByMinConfidence(
        result.signals,
        config.defaultMinConfidence ?? 0.5,
      );
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
    signals: allSignals,
    policy,
    runFaulted: units.some((u) => u.error !== undefined),
  });

  const sessionPayload = buildYagniSessionPayload(envelope, skipped, {
    graphMode: graphEvidence.mode,
    graphBuilt: graphEvidence.built,
    graphDetail: graphEvidence.detail,
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