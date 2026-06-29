/**
 * @fileoverview fit's gate-compare human renderer (ADR-0036).
 *
 * Renders the generic host `GateCompareResult` (full-`Signal` added/resolved/
 * unchanged buckets) to fit's plain-text gate-compare report. Byte-preserved from
 * the pre-ADR-0036 `gate.ts` `renderGateCompareOutput` — only the bucket element
 * type changed (`GateViolation` → `Signal`), and `Signal` carries the same
 * `ruleId`/`filePath`/`line`/`message` fields the old renderer read.
 */

import { renderGateCompareLines } from '@opensip-cli/core';

import type { GateCompareResult } from '@opensip-cli/core';

/** Render fit's gate-compare report. Byte-preserved from the old gate.ts renderer. */
export function renderGateCompareOutput(result: GateCompareResult): string {
  return renderGateCompareLines(result, {
    title: 'opensip gate compare',
    singularNoun: 'violation',
  }).join('\n');
}
