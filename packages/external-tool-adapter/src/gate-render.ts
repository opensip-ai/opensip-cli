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

// @fitness-ignore-file duplicate-utility-functions -- intentional: this adapter-family gate-compare renderer is a layer-4 PEER of fitness's gate-compare-render (ADR-0036). Both render the host GateCompareResult to their own tool's command surface and cannot import each other; sharing the small Signal-location/sort helpers would require a core extraction (a separate refactor touching fit's byte-preserved renderer). Per-tool command-surface presentation is duplicated by design — same rationale as cli-ui/format-duration and the fit/graph/sim replay projections.

import type { GateCompareResult, Signal } from '@opensip-cli/core';

/** `file:line`, `file`, or `(no location)` for a signal. */
function formatLocation(s: Signal): string {
  if (!s.filePath) return '(no location)';
  return s.line == null ? s.filePath : `${s.filePath}:${s.line}`;
}

/** Stable ruleId → filePath → line ordering so the diff is deterministic. */
function sortSignals(signals: readonly Signal[]): Signal[] {
  return [...signals].sort((a, b) => {
    if (a.ruleId !== b.ruleId) return a.ruleId.localeCompare(b.ruleId);
    if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
    return (a.line ?? 0) - (b.line ?? 0);
  });
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** The `gate-save` lines: baseline captured into the project store. */
export function renderGateSaveLines(tool: string, signalCount: number): string[] {
  return [`${tool}: baseline saved (project SQLite store)`, `  ${signalCount} finding(s) recorded`];
}

/** `Added (n):` — each net-new finding + its (truncated) message. */
function renderAdded(added: readonly Signal[]): string[] {
  if (added.length === 0) return [];
  const lines = [`Added (${added.length}):`];
  for (const v of sortSignals(added)) {
    lines.push(`  ✗ ${v.ruleId.padEnd(40)} ${formatLocation(v)}`);
    if (v.message && v.message !== v.ruleId) lines.push(`      ${truncate(v.message, 120)}`);
  }
  lines.push('');
  return lines;
}

/** `Resolved (n):` — findings cleared since the baseline. */
function renderResolved(resolved: readonly Signal[]): string[] {
  if (resolved.length === 0) return [];
  const lines = [`Resolved (${resolved.length}):`];
  for (const v of sortSignals(resolved)) {
    lines.push(`  ✓ ${v.ruleId.padEnd(40)} ${formatLocation(v)}`);
  }
  lines.push('');
  return lines;
}

/** `Unchanged (n):` — sampled to the first 5 (usually long, not actionable). */
function renderUnchanged(unchanged: readonly Signal[]): string[] {
  if (unchanged.length === 0) return [];
  const lines = [`Unchanged (${unchanged.length}):`];
  const sample = sortSignals(unchanged).slice(0, 5);
  for (const v of sample) lines.push(`  · ${v.ruleId.padEnd(40)} ${formatLocation(v)}`);
  if (unchanged.length > sample.length) {
    lines.push(`  · ... and ${unchanged.length - sample.length} more`);
  }
  lines.push('');
  return lines;
}

/** The verdict footer (`DEGRADED` / `IMPROVED` / `STABLE`). */
function renderVerdict(result: GateCompareResult): string {
  if (result.degraded) {
    const n = result.added.length;
    return `✗ DEGRADED — ${n} new finding${n === 1 ? '' : 's'}`;
  }
  if (result.resolved.length > 0) {
    const n = result.resolved.length;
    return `✓ IMPROVED — ${n} finding${n === 1 ? '' : 's'} resolved, none added`;
  }
  return '✓ STABLE — no change';
}

/** The full `gate-compare` presentation lines for a {@link GateCompareResult}. */
export function renderGateCompareLines(tool: string, result: GateCompareResult): string[] {
  return [
    `${tool} gate compare`,
    '',
    ...renderAdded(result.added),
    ...renderResolved(result.resolved),
    ...renderUnchanged(result.unchanged),
    renderVerdict(result),
  ];
}
