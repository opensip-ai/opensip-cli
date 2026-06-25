import { isErrorSignal } from '@opensip-cli/core';

import type { SignalEnvelope, UnitResult } from '@opensip-cli/contracts';
import type { Signal } from '@opensip-cli/core';

export type SimulationFindingSeverity = 'error' | 'warning';

export interface SimulationSessionFinding {
  readonly ruleId: string;
  readonly message: string;
  readonly severity: SimulationFindingSeverity;
  readonly filePath?: string;
  readonly line?: number;
  readonly column?: number;
  readonly suggestion?: string;
}

export interface SimulationSessionCheck {
  readonly checkSlug: string;
  readonly passed: boolean;
  readonly violationCount: number;
  readonly findings: readonly SimulationSessionFinding[];
  readonly durationMs: number;
}

export interface SimulationSessionPayload {
  /** Inner version per the payload schema evolution convention (v1 shape). */
  readonly __version: 1;
  readonly summary: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly errors: number;
    readonly warnings: number;
  };
  readonly checks: readonly SimulationSessionCheck[];
}

export function buildSimulationSessionPayload(envelope: SignalEnvelope): SimulationSessionPayload {
  const bySource = new Map<string, Signal[]>();
  for (const signal of envelope.signals) {
    const bucket = bySource.get(signal.source);
    if (bucket) bucket.push(signal);
    else bySource.set(signal.source, [signal]);
  }

  const checks = envelope.units.map((unit: UnitResult) => {
    const findings = findingsFor(bySource.get(unit.slug) ?? []);
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
    },
    checks,
  };
}

function findingsFor(signals: readonly Signal[]): SimulationSessionFinding[] {
  return signals.map((signal) => ({
    ruleId: signal.ruleId,
    message: signal.message,
    severity: isErrorSignal(signal) ? 'error' : 'warning',
    ...(signal.filePath === '' ? {} : { filePath: signal.filePath }),
    ...(signal.line === undefined ? {} : { line: signal.line }),
    ...(signal.column === undefined ? {} : { column: signal.column }),
    ...(signal.suggestion === undefined ? {} : { suggestion: signal.suggestion }),
  }));
}
