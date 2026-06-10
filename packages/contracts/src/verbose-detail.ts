/**
 * Verbose-detail builders (ADR-0021) — the shared transform from a run's
 * `Signal[]` + units into the renderer-agnostic `FindingGroup[]` carried on a
 * `*DoneResult` and rendered by the cli `resultToView` seam.
 *
 * Lives in contracts (next to `buildSignalEnvelope`) so fit and sim — peer
 * packages that cannot import each other — share ONE mapping rather than each
 * re-deriving it (which would also trip the `graph:duplicated-function-body`
 * dogfood check). contracts may import `@opensip-tools/core` at runtime (the
 * layer below it), so `isErrorSignal` is available here.
 */

import { isErrorSignal, type Signal } from '@opensip-tools/core';

import type { FindingGroup, FindingLine } from './command-results.js';

/** Map one `Signal` to a renderer-agnostic `FindingLine` (display fields only,
 *  4-level severity collapsed to the 2-level error/warning rung). */
function toFindingLine(signal: Signal): FindingLine {
  let location: string | undefined;
  if (signal.filePath !== '') {
    location =
      signal.line === undefined ? signal.filePath : `${signal.filePath}:${String(signal.line)}`;
  }
  return {
    severity: isErrorSignal(signal) ? 'error' : 'warning',
    message: signal.message,
    ...(location === undefined ? {} : { location }),
    ...(signal.suggestion === undefined ? {} : { suggestion: signal.suggestion }),
  };
}

/** A unit identity the grouping needs: its slug and (optional) own error. */
export interface FindingGroupUnit {
  readonly slug: string;
  readonly error?: string;
}

/** Group a run's signals by `signal.source` (the emitting unit's slug). */
function indexBySource(signals: readonly Signal[]): Map<string, Signal[]> {
  const bySource = new Map<string, Signal[]>();
  for (const signal of signals) {
    const bucket = bySource.get(signal.source);
    if (bucket) bucket.push(signal);
    else bySource.set(signal.source, [signal]);
  }
  return bySource;
}

/** Build one finding group for a unit + its findings (counts the rungs). */
function groupForUnit(
  unit: FindingGroupUnit,
  findings: readonly Signal[],
  title: string,
): FindingGroup {
  let errorCount = 0;
  let warningCount = 0;
  for (const s of findings) {
    if (isErrorSignal(s)) errorCount += 1;
    else warningCount += 1;
  }
  return {
    title,
    ...(unit.error === undefined ? {} : { error: unit.error }),
    errorCount,
    warningCount,
    findings: findings.map(toFindingLine),
  };
}

/**
 * Group a run's signals by `signal.source` (the emitting unit's slug) into the
 * verbose `FindingGroup[]` — one block per unit that emitted ≥1 finding or that
 * errored. `displayName` resolves a unit slug to its pretty title (fitness
 * passes its display registry; sim passes identity).
 */
export function buildFindingGroups(
  units: readonly FindingGroupUnit[],
  signals: readonly Signal[],
  displayName: (slug: string) => string = (slug) => slug,
): FindingGroup[] {
  const bySource = indexBySource(signals);
  const groups: FindingGroup[] = [];
  for (const unit of units) {
    const findings = bySource.get(unit.slug) ?? [];
    if (findings.length === 0 && unit.error === undefined) continue;
    groups.push(groupForUnit(unit, findings, displayName(unit.slug)));
  }
  return groups;
}
