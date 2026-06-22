import { isErrorSignal } from '@opensip-cli/core';

import type { SkippedDetector } from '../detectors/types.js';
import type { YagniGraphMode } from '../types/yagni-config.js';
import type { YagniRunSummary } from '../types/yagni-metadata.js';
import type { SignalEnvelope } from '@opensip-cli/contracts';
import type { Signal } from '@opensip-cli/core';

export interface YagniSessionFinding {
  readonly ruleId: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
  readonly filePath?: string;
  readonly line?: number;
  readonly column?: number;
  readonly suggestion?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface YagniSessionDetector {
  readonly detectorSlug: string;
  readonly passed: boolean;
  readonly violationCount: number;
  readonly findings: readonly YagniSessionFinding[];
  readonly durationMs: number;
}

export interface YagniSessionPayload {
  readonly __version: 1;
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly errors: number;
    readonly warnings: number;
    readonly skippedDetectors: readonly SkippedDetector[];
    readonly graphMode?: YagniGraphMode;
    readonly graphBuilt?: boolean;
    readonly graphDetail?: string;
    readonly yagni: YagniRunSummary;
  };
  readonly detectors: readonly YagniSessionDetector[];
}

export function buildYagniSessionPayload(
  envelope: SignalEnvelope,
  skippedDetectors: readonly SkippedDetector[],
  graph: {
    readonly graphMode: YagniGraphMode;
    readonly graphBuilt: boolean;
    readonly graphDetail?: string;
    readonly yagniSummary: YagniRunSummary;
  },
): YagniSessionPayload {
  const bySource = new Map<string, Signal[]>();
  for (const signal of envelope.signals) {
    const bucket = bySource.get(signal.source);
    if (bucket) bucket.push(signal);
    else bySource.set(signal.source, [signal]);
  }

  const detectors = envelope.units.map((unit) => {
    const findings = (bySource.get(unit.slug) ?? []).map((signal) => ({
      ruleId: signal.ruleId,
      message: signal.message,
      severity: isErrorSignal(signal) ? ('error' as const) : ('warning' as const),
      ...(signal.filePath === '' ? {} : { filePath: signal.filePath }),
      ...(signal.line === undefined ? {} : { line: signal.line }),
      ...(signal.column === undefined ? {} : { column: signal.column }),
      ...(signal.suggestion === undefined ? {} : { suggestion: signal.suggestion }),
      metadata: signal.metadata,
    }));
    return {
      detectorSlug: unit.slug,
      passed: unit.passed,
      violationCount: unit.violationCount ?? findings.length,
      findings,
      durationMs: unit.durationMs,
    };
  });

  const { summary } = envelope.verdict;
  return {
    __version: 1,
    summary: {
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      errors: summary.errors,
      warnings: summary.warnings,
      skippedDetectors,
      graphMode: graph.graphMode,
      graphBuilt: graph.graphBuilt,
      ...(graph.graphDetail === undefined ? {} : { graphDetail: graph.graphDetail }),
      yagni: graph.yagniSummary,
    },
    detectors,
  };
}
