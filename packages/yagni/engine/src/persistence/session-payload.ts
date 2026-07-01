import { isErrorSignal, isPlainRecord } from '@opensip-cli/core';

import type { SkippedDetector } from '../detectors/types.js';
import type { YagniRunSummary } from '../types/yagni-metadata.js';
import type { SignalEnvelope } from '@opensip-cli/contracts';
import type { Signal, SignalRepair } from '@opensip-cli/core';

export interface YagniSessionFinding {
  readonly ruleId: string;
  readonly message: string;
  readonly severity: 'error' | 'warning';
  readonly filePath?: string;
  readonly line?: number;
  readonly column?: number;
  readonly suggestion?: string;
  /** Structured repair guidance (ADR-0086) — round-trips through replay. */
  readonly repair?: SignalRepair;
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
    readonly yagni: YagniRunSummary;
  };
  // Shared key with fitness/graph/sim so the host dashboard's session-detail
  // renderer picks it up; each entry is one yagni detector (see YagniSessionCheck).
  readonly checks: readonly YagniSessionCheck[];
}

function readNumber(raw: Record<string, unknown>, key: string): number {
  const value = raw[key];
  return typeof value === 'number' ? value : 0;
}

function parseYagniRunSummary(yagniRaw: Record<string, unknown>): YagniRunSummary {
  const byConfidence = isPlainRecord(yagniRaw.byConfidence) ? yagniRaw.byConfidence : {};
  return {
    totalCandidates: readNumber(yagniRaw, 'totalCandidates'),
    byConfidence: {
      high: readNumber(byConfidence, 'high'),
      medium: readNumber(byConfidence, 'medium'),
      low: readNumber(byConfidence, 'low'),
    },
    estimatedTotalLocReduction: readNumber(yagniRaw, 'estimatedTotalLocReduction'),
    skippedDetectors: Array.isArray(yagniRaw.skippedDetectors)
      ? yagniRaw.skippedDetectors.filter(isPlainRecord).map((s) => ({
          slug: typeof s.slug === 'string' ? s.slug : '',
          reason: typeof s.reason === 'string' ? s.reason : 'disabled',
          ...(typeof s.detail === 'string' ? { detail: s.detail } : {}),
        }))
      : [],
  };
}

function parseSkippedDetectors(summaryRaw: Record<string, unknown>): SkippedDetector[] {
  if (!Array.isArray(summaryRaw.skippedDetectors)) return [];
  return summaryRaw.skippedDetectors.filter(isPlainRecord).map((s) => ({
    id: typeof s.id === 'string' ? s.id : '',
    slug: typeof s.slug === 'string' ? s.slug : '',
    reason: 'disabled' as const,
    ...(typeof s.detail === 'string' ? { detail: s.detail } : {}),
  }));
}

/**
 * Forward-compatible loader for persisted yagni session payloads.
 * Pre-feature rows may still carry removed `graphMode`/`graphBuilt`/`graphDetail`
 * fields — they are ignored rather than rejected.
 */
export function readYagniSessionPayload(raw: unknown): YagniSessionPayload | undefined {
  if (!isPlainRecord(raw) || raw.__version !== 1) return undefined;
  if (!isPlainRecord(raw.summary) || !Array.isArray(raw.checks)) return undefined;

  const summaryRaw = raw.summary;
  const yagniRaw = summaryRaw.yagni;
  if (!isPlainRecord(yagniRaw)) return undefined;

  return {
    __version: 1,
    summary: {
      total: readNumber(summaryRaw, 'total'),
      passed: readNumber(summaryRaw, 'passed'),
      failed: readNumber(summaryRaw, 'failed'),
      errors: readNumber(summaryRaw, 'errors'),
      warnings: readNumber(summaryRaw, 'warnings'),
      skippedDetectors: parseSkippedDetectors(summaryRaw),
      yagni: parseYagniRunSummary(yagniRaw),
    },
    checks: raw.checks as YagniSessionCheck[],
  };
}

export function buildYagniSessionPayload(
  envelope: SignalEnvelope,
  skippedDetectors: readonly SkippedDetector[],
  yagniSummary: YagniRunSummary,
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
      ...(signal.repair === undefined ? {} : { repair: signal.repair }),
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
      yagni: yagniSummary,
    },
    checks,
  };
}
