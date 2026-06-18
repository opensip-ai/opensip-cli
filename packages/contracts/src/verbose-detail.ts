/**
 * Verbose-detail currency + builders (ADR-0021) — the renderer-agnostic
 * `VerboseDetail` type carried on a run's render adjunct (RunPresentation; the
 * legacy `*DoneResult` until RP-3) and the shared transform from a run's
 * `Signal[]` + units into the `FindingGroup[]` the cli `resultToView` seam
 * renders.
 *
 * The TYPES (`VerboseDetail` / `FindingGroup` / `FindingLine`) live here — not
 * in `command-results.ts` — so that both `command-results.ts` (the legacy
 * `*DoneResult` variants) and `run-presentation.ts` (the new render adjunct) can
 * import them WITHOUT forming a cycle: `command-results.ts → run-presentation.ts
 * → command-results.ts` was a no-circular violation. This module is the single
 * "verbose detail currency" home, downstream of nothing in contracts except
 * `@opensip-cli/core`.
 *
 * Lives in contracts (next to `buildSignalEnvelope`) so fit and sim — peer
 * packages that cannot import each other — share ONE mapping rather than each
 * re-deriving it (which would also trip the `graph:duplicated-function-body`
 * dogfood check). contracts may import `@opensip-cli/core` at runtime (the
 * layer below it), so `isErrorSignal` is available here.
 */

import { isErrorSignal, type Signal } from '@opensip-cli/core';

// --- Verbose detail currency (ADR-0021) -------------------------------------
//
// `--verbose` is an output-currency concern, not a per-tool live-runner concern.
// A tool's verbose "detail body" is carried as renderer-agnostic data on its
// render adjunct (RunPresentation) and rendered ONCE by the cli `resultToView`
// seam, so it is identical in a TTY and a pipe. The body is a typed union so
// tools that have line-oriented detail (graph's catalog/findings/entry-point
// dump) and tools with per-finding detail (fit/sim, coloured by severity) share
// one carrier without flattening one into the other.

/** One displayed finding inside a verbose findings group. Display fields only —
 *  no core `Signal` type leaks into contracts. */
export interface FindingLine {
  readonly severity: 'error' | 'warning';
  readonly message: string;
  /** Source location for display, e.g. `"path/to/file.ts:42"`. */
  readonly location?: string;
  readonly suggestion?: string;
}

/** A verbose findings block — one per unit (check / scenario) that emitted ≥1
 *  finding, or that errored. */
export interface FindingGroup {
  /** Display name (pretty), falling back to the unit slug. */
  readonly title: string;
  /** Set when the unit itself errored (vs. emitted findings). */
  readonly error?: string;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly findings: readonly FindingLine[];
}

/** Renderer-agnostic verbose detail body carried on a run's render adjunct.
 *  `resultToView` switches on `kind`: `lines` → verbatim text; `findings` → the
 *  coloured findings block (rendered identically in Ink and plain text). */
export type VerboseDetail =
  | { readonly kind: 'lines'; readonly lines: readonly string[] }
  | { readonly kind: 'findings'; readonly groups: readonly FindingGroup[] };

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

/**
 * Group a run's signals by `signal.source` (the emitting unit's slug) into a
 * `slug → Signal[]` index.
 *
 * The single shared home for this mapping (this module's whole reason to exist):
 * fitness's and graph's live-view derivations (`envelopeToFitRows` /
 * `envelopeToGraphRows`) both bucket envelope signals by source before counting
 * per-unit errors/warnings. They are peer packages that cannot import each other,
 * so re-deriving it in each tripped the `graph:duplicated-function-body` dogfood
 * check — they import this instead. `buildFindingGroups` below uses it too.
 */
export function groupSignalsBySource(signals: readonly Signal[]): Map<string, Signal[]> {
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
  const bySource = groupSignalsBySource(signals);
  const groups: FindingGroup[] = [];
  for (const unit of units) {
    const findings = bySource.get(unit.slug) ?? [];
    if (findings.length === 0 && unit.error === undefined) continue;
    groups.push(groupForUnit(unit, findings, displayName(unit.slug)));
  }
  return groups;
}
