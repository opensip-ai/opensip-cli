/**
 * @fileoverview signal-table formatter (ADR-0011, Phase 2 Task 2.5).
 *
 * Derives the terminal-table view-model purely from the envelope's `units` +
 * `signals` — one row per unit — so tools stop pre-computing `TableRow[]` on
 * their `*DoneResult` (today fitness builds rows in
 * `result-builders.ts:buildFitDoneResult`). The Ink `ResultsTable` (cli-ui)
 * consumes these rows; this layer does no Ink and no IO (formatter-purity
 * contract).
 *
 * Unlike json/sarif, the table is structured, not a single string — so this
 * exports a row/summary view-model builder rather than a `Formatter`
 * (`(envelope) => string`). The Ink renderer (cli-ui) is the string side.
 *
 * The envelope carries only what a flat `Signal[]` cannot express (ran,
 * errored, timing); fitness-only columns (`validated`/`ignored`) are NOT
 * envelope-expressible and are intentionally absent from this neutral row.
 */
import { formatDuration } from '@opensip-tools/core';

import type { SignalEnvelope, UnitResult } from '@opensip-tools/contracts';
import type { Signal } from '@opensip-tools/core';

/** Per-unit terminal-table row, derived from a {@link UnitResult} + its signals. */
export interface SignalTableRow {
  /** Unit slug (check / rule / scenario id). */
  readonly unit: string;
  /** PASS when the unit emitted no critical/high signals and did not error. */
  readonly status: 'PASS' | 'FAIL' | 'ERROR';
  /** Count of this unit's `critical`/`high` signals. */
  readonly errors: number;
  /** Count of this unit's `medium`/`low` signals. */
  readonly warnings: number;
  /** Pretty duration (`"450ms"` / `"1.5s"`). */
  readonly duration: string;
  /** Raw duration in milliseconds (for sorting / re-formatting). */
  readonly durationMs: number;
  /** The unit's error message, when it errored (status `ERROR`). */
  readonly error?: string;
}

/** Aggregate summary line for the terminal table, derived from the verdict. */
export interface SignalTableSummary {
  readonly passed: number;
  readonly failed: number;
  readonly totalErrors: number;
  readonly totalWarnings: number;
  readonly durationMs: number;
}

/** A signal is an "error" rung when it is `critical` or `high`; else a "warning". */
function isErrorSignal(signal: Signal): boolean {
  return signal.severity === 'critical' || signal.severity === 'high';
}

/** Group a run's signals by their `source` (the emitting unit's slug). */
function groupSignalsBySource(signals: readonly Signal[]): Map<string, Signal[]> {
  const bySource = new Map<string, Signal[]>();
  for (const signal of signals) {
    const bucket = bySource.get(signal.source);
    if (bucket) bucket.push(signal);
    else bySource.set(signal.source, [signal]);
  }
  return bySource;
}

/** Status for a unit: ERROR when it errored, else PASS/FAIL from `unit.passed`. */
function rowStatus(unit: UnitResult): SignalTableRow['status'] {
  if (unit.error !== undefined) return 'ERROR';
  return unit.passed ? 'PASS' : 'FAIL';
}

/**
 * Build one {@link SignalTableRow} per unit, attributing signals to units by
 * `signal.source === unit.slug`. Pure: no IO, no clock.
 */
export function formatSignalTableRows(envelope: SignalEnvelope): SignalTableRow[] {
  const bySource = groupSignalsBySource(envelope.signals);

  return envelope.units.map((unit) => {
    const unitSignals = bySource.get(unit.slug) ?? [];
    let errors = 0;
    let warnings = 0;
    for (const signal of unitSignals) {
      if (isErrorSignal(signal)) errors += 1;
      else warnings += 1;
    }
    return {
      unit: unit.slug,
      status: rowStatus(unit),
      errors,
      warnings,
      duration: formatDuration(unit.durationMs),
      durationMs: unit.durationMs,
      error: unit.error,
    };
  });
}

/** Build the aggregate summary line from the envelope's verdict. Pure. */
export function formatSignalTableSummary(envelope: SignalEnvelope): SignalTableSummary {
  const { summary } = envelope.verdict;
  const durationMs = envelope.units.reduce((total, unit) => total + unit.durationMs, 0);
  return {
    passed: summary.passed,
    failed: summary.failed,
    totalErrors: summary.errors,
    totalWarnings: summary.warnings,
    durationMs,
  };
}
