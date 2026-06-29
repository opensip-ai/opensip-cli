/**
 * @fileoverview Pure gate-ratchet presentation for the scan loop (ADR-0036).
 *
 * The substrate inherits the host baseline/ratchet plane verbatim (the four
 * `ToolCliContext` baseline seams over `signal.fingerprint`); these helpers
 * render the `gate-done` presentation lines for `--gate-save` (baseline written)
 * and `--gate-compare` (the added/resolved/unchanged diff + verdict). They are
 * the adapter-family equivalent of fitness's `gate-compare-render` — a separate
 * pure module so the run loop (the IO-excluded orchestration) stays thin and the
 * rendering is unit-covered. No `cli`/IO here: input is the `GateCompareResult`
 * the host compare seam returns; output is plain `string[]` for `cli.render`.
 */

import { renderGateCompareLines as renderCoreGateCompareLines } from '@opensip-cli/core';

import type { GateCompareResult } from '@opensip-cli/core';

/** The `gate-save` lines: baseline captured into the project store. */
export function renderGateSaveLines(tool: string, signalCount: number): string[] {
  return [`${tool}: baseline saved (project SQLite store)`, `  ${signalCount} finding(s) recorded`];
}

/** The full `gate-compare` presentation lines for a {@link GateCompareResult}. */
export function renderGateCompareLines(tool: string, result: GateCompareResult): string[] {
  return renderCoreGateCompareLines(result, {
    title: `${tool} gate compare`,
    singularNoun: 'finding',
  });
}
