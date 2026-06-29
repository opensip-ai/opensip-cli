import type { GateCompareResult } from './tool-results.js';
import type { Signal } from '../types/signal.js';

/** Labels and truncation limits for shared gate-compare rendering. */
export interface GateCompareRenderOptions {
  readonly title: string;
  readonly singularNoun: string;
  readonly pluralNoun?: string;
  readonly messageMax?: number;
  readonly unchangedSampleLimit?: number;
}

const DEFAULT_MESSAGE_MAX = 120;
const DEFAULT_UNCHANGED_SAMPLE_LIMIT = 5;

/** `file:line`, `file`, or `(no location)` for a signal. */
function formatLocation(signal: Signal): string {
  if (!signal.filePath) return '(no location)';
  return signal.line == null ? signal.filePath : `${signal.filePath}:${signal.line}`;
}

/** Stable ruleId -> filePath -> line ordering so the diff is deterministic. */
function sortSignals(signals: readonly Signal[]): Signal[] {
  return [...signals].sort((a, b) => {
    if (a.ruleId !== b.ruleId) return a.ruleId.localeCompare(b.ruleId);
    if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath);
    return (a.line ?? 0) - (b.line ?? 0);
  });
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function noun(count: number, options: GateCompareRenderOptions): string {
  if (count === 1) return options.singularNoun;
  return options.pluralNoun ?? `${options.singularNoun}s`;
}

function renderAdded(
  added: readonly Signal[],
  options: GateCompareRenderOptions,
): readonly string[] {
  if (added.length === 0) return [];
  const lines = [`Added (${added.length}):`];
  for (const signal of sortSignals(added)) {
    lines.push(`  ✗ ${signal.ruleId.padEnd(40)} ${formatLocation(signal)}`);
    if (signal.message && signal.message !== signal.ruleId) {
      lines.push(`      ${truncate(signal.message, options.messageMax ?? DEFAULT_MESSAGE_MAX)}`);
    }
  }
  lines.push('');
  return lines;
}

function renderResolved(resolved: readonly Signal[]): readonly string[] {
  if (resolved.length === 0) return [];
  const lines = [`Resolved (${resolved.length}):`];
  for (const signal of sortSignals(resolved)) {
    lines.push(`  ✓ ${signal.ruleId.padEnd(40)} ${formatLocation(signal)}`);
  }
  lines.push('');
  return lines;
}

function renderUnchanged(
  unchanged: readonly Signal[],
  options: GateCompareRenderOptions,
): readonly string[] {
  if (unchanged.length === 0) return [];
  const lines = [`Unchanged (${unchanged.length}):`];
  const sample = sortSignals(unchanged).slice(
    0,
    options.unchangedSampleLimit ?? DEFAULT_UNCHANGED_SAMPLE_LIMIT,
  );
  for (const signal of sample) {
    lines.push(`  · ${signal.ruleId.padEnd(40)} ${formatLocation(signal)}`);
  }
  if (unchanged.length > sample.length) {
    lines.push(`  · ... and ${unchanged.length - sample.length} more`);
  }
  lines.push('');
  return lines;
}

function renderVerdict(result: GateCompareResult, options: GateCompareRenderOptions): string {
  if (result.degraded) {
    const count = result.added.length;
    return `✗ DEGRADED — ${count} new ${noun(count, options)}`;
  }
  if (result.resolved.length > 0) {
    const count = result.resolved.length;
    return `✓ IMPROVED — ${count} ${noun(count, options)} resolved, none added`;
  }
  return '✓ STABLE — no change';
}

/** Render the generic host baseline/ratchet diff for a tool command surface. */
export function renderGateCompareLines(
  result: GateCompareResult,
  options: GateCompareRenderOptions,
): string[] {
  return [
    options.title,
    '',
    ...renderAdded(result.added, options),
    ...renderResolved(result.resolved),
    ...renderUnchanged(result.unchanged, options),
    renderVerdict(result, options),
  ];
}
