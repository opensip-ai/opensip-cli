/**
 * Gate baseline save / compare per §10 P6.
 *
 * --gate-save writes the current Signal set to the SQLite-backed
 * graph_baseline_signals table.
 * --gate-compare diffs current vs baseline; non-zero exit on
 * regression. Comparison is fingerprint-based: rule + file + line +
 * message identifies a finding.
 */

import { ValidationError } from '@opensip-tools/core';

import type { GraphBaselineRepo } from './persistence/baseline-repo.js';
import type { Signal } from '@opensip-tools/core';

export interface GateCompareResult {
  readonly degraded: boolean;
  readonly newSignals: readonly Signal[];
  readonly resolvedFingerprints: readonly string[];
}

export function fingerprintSignal(s: Signal): string {
  return `${s.ruleId}|${s.filePath}|${String(s.line ?? 0)}|${s.message}`;
}

export function saveBaseline(signals: readonly Signal[], repo: GraphBaselineRepo): void {
  repo.save(signals);
}

export function compareToBaseline(
  signals: readonly Signal[],
  repo: GraphBaselineRepo,
): GateCompareResult {
  if (!repo.exists()) {
    throw new ValidationError('Graph baseline not found. Run with --gate-save first.');
  }
  const baselineSet = new Set(repo.loadFingerprints());
  const currentByFp = new Map<string, Signal>();
  for (const s of signals) currentByFp.set(fingerprintSignal(s), s);

  const newSignals: Signal[] = [];
  for (const [fp, s] of currentByFp.entries()) {
    if (!baselineSet.has(fp)) newSignals.push(s);
  }
  const resolved: string[] = [];
  for (const fp of baselineSet) {
    if (!currentByFp.has(fp)) resolved.push(fp);
  }

  return {
    degraded: newSignals.length > 0,
    newSignals,
    resolvedFingerprints: resolved,
  };
}
