/**
 * Gate baseline save / compare (skeleton; implemented in P6).
 *
 * --gate-save writes the current Signal set to baseline.json.
 * --gate-compare reads baseline, diffs against current, exits non-zero
 * on regression.
 */

import type { Signal } from '@opensip-tools/core';

export interface GateCompareResult {
  readonly degraded: boolean;
  readonly newSignals: readonly Signal[];
  readonly resolvedSignals: readonly Signal[];
}

export function saveBaseline(_signals: readonly Signal[], _baselinePath: string): void {
  throw new Error('saveBaseline: not implemented (Phase P6).');
}

export function compareToBaseline(
  _signals: readonly Signal[],
  _baselinePath: string,
): GateCompareResult {
  throw new Error('compareToBaseline: not implemented (Phase P6).');
}
