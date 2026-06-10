/**
 * @fileoverview Fitness live-view derivation from the run's `SignalEnvelope`
 * (ADR-0011, Phase 6).
 *
 * The shared `formatSignalTableRows` (`@opensip-tools/output`) is the canonical
 * neutral table for the static/non-TTY render path — but fitness's PRODUCTION
 * source must not import `@opensip-tools/output` (the root owns egress; output
 * is the egress/format layer). So the TTY live view derives its richer,
 * fitness-specific table (display names + the `Validated`/`Ignores` columns)
 * straight from the envelope here, using only `@opensip-tools/contracts`
 * (envelope/units) + `@opensip-tools/core` (signals). This is the
 * decision-B fallback: ONE neutral formatter for the shared path, plus a
 * tool-specific rich view for fitness's terminal UX — both fed by the same
 * `UnitResult` facts (`filesValidated`/`itemType`/`ignoredCount`), so there is
 * a single source of truth.
 *
 * Pure: no IO, no clock. `getDisplayName` is a registry lookup (display only).
 */

import { formatValidatedColumn } from '@opensip-tools/cli-ui';
import { buildFindingGroups } from '@opensip-tools/contracts';
import { formatDuration, isErrorSignal } from '@opensip-tools/core';

import { getDisplayName } from './display-registry.js';

import type { SignalEnvelope, UnitResult, VerboseDetail } from '@opensip-tools/contracts';
import type { Signal } from '@opensip-tools/core';

/** A live-view results-table row — one per check unit, with fitness columns. */
export interface FitTableRow {
  /** Display name (pretty, via the display registry), falling back to the slug. */
  readonly check: string;
  readonly status: 'PASS' | 'FAIL' | 'ERROR';
  readonly errors: number;
  readonly warnings: number;
  /** Files/items scanned this run (raw count; rendered with the noun). */
  readonly validated?: number;
  readonly itemType?: string;
  /** Findings suppressed by an inline ignore directive. */
  readonly ignored: number;
  readonly duration: string;
  readonly durationMs: number;
}

/** Group a run's signals by `signal.source` (the emitting check's slug). */
function groupBySource(signals: readonly Signal[]): Map<string, Signal[]> {
  const bySource = new Map<string, Signal[]>();
  for (const signal of signals) {
    const bucket = bySource.get(signal.source);
    if (bucket) bucket.push(signal);
    else bySource.set(signal.source, [signal]);
  }
  return bySource;
}

function rowStatus(unit: UnitResult): FitTableRow['status'] {
  if (unit.error !== undefined) return 'ERROR';
  return unit.passed ? 'PASS' : 'FAIL';
}

/** Build the live-view results-table rows from the envelope (one row per unit). */
export function envelopeToFitRows(envelope: SignalEnvelope): FitTableRow[] {
  const bySource = groupBySource(envelope.signals);
  return envelope.units.map((unit) => {
    const unitSignals = bySource.get(unit.slug) ?? [];
    let errors = 0;
    let warnings = 0;
    for (const s of unitSignals) {
      if (isErrorSignal(s)) errors += 1;
      else warnings += 1;
    }
    return {
      check: getDisplayName(unit.slug),
      status: rowStatus(unit),
      errors,
      warnings,
      validated: unit.filesValidated,
      itemType: unit.itemType,
      ignored: unit.ignoredCount ?? 0,
      duration: formatDuration(unit.durationMs),
      durationMs: unit.durationMs,
    };
  });
}

/** Render a row's "Validated" cell (e.g. `"450 files"`, `"—"`). */
export function fitValidatedCell(row: FitTableRow): string {
  return formatValidatedColumn(row.validated, row.itemType);
}

/**
 * Build the run's verbose detail body (ADR-0021) — `undefined` unless the run
 * asked for it (`--verbose`). Delegates the Signal[] → `FindingGroup[]` mapping
 * to the shared contracts `buildFindingGroups` (one source for fit + sim),
 * passing fit's display registry so each block is titled with the check's
 * pretty name.
 */
export function buildFitVerboseDetail(
  envelope: SignalEnvelope,
  opts: { readonly verbose?: boolean },
): VerboseDetail | undefined {
  if (opts.verbose !== true) return undefined;
  return {
    kind: 'findings',
    groups: buildFindingGroups(envelope.units, envelope.signals, getDisplayName),
  };
}
