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

/**
 * One persisted YAGNI detector result.
 *
 * Conforms to the host dashboard's shared cross-tool session-detail contract:
 * per-item detail is rendered from `payload.checks[]` keyed by `checkSlug`
 * (fitness "checks", graph "rules", and yagni "detectors" all persist under the
 * same generic keys; the dashboard relabels the column per tool at display
 * time). For YAGNI, one "check" IS one detector — `checkSlug` holds the
 * detector slug.
 */
export interface YagniSessionCheck {
  readonly checkSlug: string;
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
  // Shared key with fitness/graph/sim so the host dashboard's session-detail
  // renderer picks it up; each entry is one yagni detector (see YagniSessionCheck).
  readonly checks: readonly YagniSessionCheck[];
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

  const checks = envelope.units.map((unit) => {
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
      checkSlug: unit.slug,
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
    checks,
  };
}
