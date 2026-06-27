/**
 * Fitness-owned session payload (audit 2026-05-29, session split;
 * rebuilt from the run's {@link SignalEnvelope} in ADR-0011 Phase 6 — no
 * `CliOutput`).
 *
 * `contracts` stores per-session detail as an opaque JSON blob in
 * `session_tool_payload.payload` and holds zero check/finding/summary
 * vocabulary. Fitness owns the shape of its own payload here and ships the
 * dashboard renderer that reads it back. The dashboard's shared session-detail
 * renderer reads `{ summary, checks[] }` where each check has `checkSlug`,
 * `passed`, `violationCount`, `durationMs`, and `findings[].severity ∈
 * error|warning` (2-LEVEL) — so this payload derives FROM the envelope's
 * 4-level signals, collapsing `critical|high → error`, else `warning`. The
 * 4-level severity stays in `--json`; the 2-level lives only here (two
 * consumers, two shapes).
 */

import { isErrorSignal } from '@opensip-cli/core';

import type { SignalEnvelope, UnitResult } from '@opensip-cli/contracts';
import type { Signal, SignalRepair } from '@opensip-cli/core';

/** Two-level severity the dashboard buckets on (`critical|high → error`). */
export type FitnessFindingSeverity = 'error' | 'warning';

/** Per-check finding inside a {@link FitnessSessionPayload}. */
interface FitnessSessionFinding {
  readonly ruleId: string;
  readonly message: string;
  readonly severity: FitnessFindingSeverity;
  readonly filePath?: string;
  readonly line?: number;
  readonly column?: number;
  readonly suggestion?: string;
  /** Structured repair guidance (ADR-0086) — round-trips through replay. */
  readonly repair?: SignalRepair;
}

/** Per-check result inside a {@link FitnessSessionPayload}. */
interface FitnessSessionCheck {
  readonly checkSlug: string;
  readonly passed: boolean;
  readonly violationCount?: number;
  readonly findings: readonly FitnessSessionFinding[];
  readonly durationMs: number;
}

/** Opaque-to-contracts detail blob written for every `fit` session. */
export interface FitnessSessionPayload {
  /** Inner version per the payload schema evolution convention (v1 shape). */
  readonly __version: 1;
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly errors: number;
    readonly warnings: number;
  };
  readonly checks: readonly FitnessSessionCheck[];
}

/** Map a signal to the dashboard's 2-level bucket (`critical|high → error`). */
function toDashboardSeverity(signal: Signal): FitnessFindingSeverity {
  return isErrorSignal(signal) ? 'error' : 'warning';
}

/** Map a check's signals into the dashboard-shaped finding rows. */
function findingsFor(signals: readonly Signal[]): FitnessSessionFinding[] {
  return signals.map((s) => ({
    ruleId: s.ruleId,
    message: s.message,
    severity: toDashboardSeverity(s),
    filePath: s.filePath,
    line: s.line,
    column: s.column,
    suggestion: s.suggestion,
    ...(s.repair === undefined ? {} : { repair: s.repair }),
  }));
}

/**
 * Build the fitness session payload directly from the run's
 * {@link SignalEnvelope}.
 *
 * One `checks[]` entry per `units[]` row (every check that ran — a clean check
 * still appears, matching the dashboard's per-check catalog stats), with its
 * findings recovered by grouping `signals` on `signal.source === unit.slug`.
 * The 4-level signal severity is collapsed to the dashboard's `error|warning`.
 * `summary` is taken from the envelope's verdict, which already counts
 * `critical|high → errors`, else `warnings`.
 *
 * The returned payload includes `__version: 1` (the current v1 shape per the
 * tool-owned payload evolution convention). Additive changes stay on v1;
 * breaking changes will bump the number (with deprecation per the rules).
 */
export function buildFitnessSessionPayload(envelope: SignalEnvelope): FitnessSessionPayload {
  const bySource = new Map<string, Signal[]>();
  for (const s of envelope.signals) {
    const bucket = bySource.get(s.source);
    if (bucket) bucket.push(s);
    else bySource.set(s.source, [s]);
  }

  const checks: FitnessSessionCheck[] = envelope.units.map((unit: UnitResult) => ({
    checkSlug: unit.slug,
    passed: unit.passed,
    violationCount: unit.violationCount,
    findings: findingsFor(bySource.get(unit.slug) ?? []),
    durationMs: unit.durationMs,
  }));

  const { summary } = envelope.verdict;
  return {
    __version: 1,
    summary: {
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      errors: summary.errors,
      warnings: summary.warnings,
    },
    checks,
  };
}
