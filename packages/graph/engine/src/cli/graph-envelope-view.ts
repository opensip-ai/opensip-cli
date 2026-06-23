/**
 * @fileoverview Graph live-view derivation from the run's `SignalEnvelope`.
 *
 * Maps envelope units to plain {@link LiveRunTableRow} data for the shared
 * cli-ui `liveRunTable` renderer (ADR-0058). Graph engines must not import
 * `@opensip-cli/output` or the CLI host's `envelopeTableNode`.
 */

import { groupSignalsBySource } from '@opensip-cli/contracts';
import { isErrorSignal } from '@opensip-cli/core';

import type { LiveRunTableRow } from '@opensip-cli/cli-ui';
import type { SignalEnvelope, UnitResult } from '@opensip-cli/contracts';

function rowStatus(unit: UnitResult): LiveRunTableRow['status'] {
  if (unit.error !== undefined) return 'ERROR';
  return unit.passed ? 'PASS' : 'FAIL';
}

/** Build one row per unit — mirrors `formatSignalTableRows` (output) for graph. */
export function envelopeToLiveRunTableRows(envelope: SignalEnvelope): LiveRunTableRow[] {
  const bySource = groupSignalsBySource(envelope.signals);
  return envelope.units.map((unit) => {
    const unitSignals = bySource.get(unit.slug) ?? [];
    let errors = 0;
    let warnings = 0;
    for (const s of unitSignals) {
      if (isErrorSignal(s)) errors += 1;
      else warnings += 1;
    }
    return {
      unit: unit.slug,
      status: rowStatus(unit),
      errors,
      warnings,
      durationMs: unit.durationMs,
    };
  });
}
