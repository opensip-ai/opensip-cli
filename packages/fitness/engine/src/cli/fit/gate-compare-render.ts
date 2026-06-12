/**
 * @fileoverview fit's gate-compare human renderer (ADR-0036).
 *
 * Renders the generic host `GateCompareResult` (full-`Signal` added/resolved/
 * unchanged buckets) to fit's plain-text gate-compare report. Byte-preserved from
 * the pre-ADR-0036 `gate.ts` `renderGateCompareOutput` — only the bucket element
 * type changed (`GateViolation` → `Signal`), and `Signal` carries the same
 * `ruleId`/`filePath`/`line`/`message` fields the old renderer read.
 */

import type { GateCompareResult, Signal } from '@opensip-tools/core';

function formatLocation(s: Signal): string {
  if (!s.filePath) return '(no location)';
  return s.line == null ? s.filePath : `${s.filePath}:${s.line}`;
}

function sortSignals(signals: readonly Signal[]): Signal[] {
  return [...signals].sort((a, b) => {
    if (a.ruleId !== b.ruleId) return a.ruleId.localeCompare(b.ruleId);
    if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
    return (a.line ?? 0) - (b.line ?? 0);
  });
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/** `Added (n):` block — each entry plus its (truncated) message line. */
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

/** `Resolved (n):` block. */
function renderResolved(resolved: readonly Signal[]): string[] {
  if (resolved.length === 0) return [];
  const lines = [`Resolved (${resolved.length}):`];
  for (const v of sortSignals(resolved)) lines.push(`  ✓ ${v.ruleId.padEnd(40)} ${formatLocation(v)}`);
  lines.push('');
  return lines;
}

/** `Unchanged (n):` block — truncated to the first 5 (usually long, not actionable). */
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
    return `✗ DEGRADED — ${result.added.length} new violation${result.added.length === 1 ? '' : 's'}`;
  }
  if (result.resolved.length > 0) {
    return `✓ IMPROVED — ${result.resolved.length} violation${result.resolved.length === 1 ? '' : 's'} resolved, none added`;
  }
  return `✓ STABLE — no change`;
}

/** Render fit's gate-compare report. Byte-preserved from the old gate.ts renderer. */
export function renderGateCompareOutput(result: GateCompareResult): string {
  return [
    'opensip-tools gate compare',
    '',
    ...renderAdded(result.added),
    ...renderResolved(result.resolved),
    ...renderUnchanged(result.unchanged),
    renderVerdict(result),
  ].join('\n');
}
