/**
 * graph:cycle — flag call-graph cycles (strongly-connected components of size
 * ≥ 2) at function/SCC granularity. Reads the `scc` feature column (Phase C's
 * Tarjan; NO in-rule cycle detection). Bounded + actionable per ADR-0001: the
 * count reaches zero when every cycle is broken; the fix is "invert one
 * dependency or extract the shared piece."
 *
 * Severity ladder (defaults from the dashboard's former SCCs view,
 * `view-sccs.ts`: "size 2 usually fine; size 3+ spanning packages is a layering
 * smell"):
 *   - `sccSize === 1`         → no signal (not a cycle).
 *   - `crossesPackages`       → base `high` (regardless of size — cross-package
 *                               cycles are the most expensive to unwind; they
 *                               win the ladder).
 *   - `sccSize === 2`         → `config.cycleSize2Severity` (default `'off'` →
 *                               no signal; `'low'` → base `low`).
 *   - `sccSize >= cycleMinSize` (default 3) → base `medium`.
 *
 * One signal PER SCC (not per member) — anchored on the lowest-`qualifiedName`
 * member occurrence so a single tangle never produces N findings. This is the
 * function/SCC-granularity de-dup counterpart to `unexpected-coupling`'s
 * package granularity (distinct `ruleId` + `code` → distinct fingerprints,
 * cross-linked via metadata).
 *
 * Emitted severity routes through the opt-in `applySeverityOverride` clamp
 * (ADR-0005).
 */

import { pkgOf } from '../resolve-callee.js';

import { createGraphSignal } from './create-graph-signal.js';
import { defineRule } from './define-rule.js';

import type { FunctionOccurrence, Indexes, SccFeatures } from '../types.js';
import type { Signal, SignalSeverity } from '@opensip-cli/core';

const DEFAULT_CYCLE_MIN_SIZE = 3;

export const cycleRule = defineRule({
  slug: 'graph:cycle',
  defaultSeverity: 'warning',
  featureDeps: ['scc'],
  evaluate({ indexes, config, features }): readonly Signal[] {
    // Absent feature table → emit nothing (SCC detection is Phase C's job;
    // no in-rule Tarjan).
    if (!features) return [];
    const minSize = config.cycleMinSize ?? DEFAULT_CYCLE_MIN_SIZE;
    const size2 = config.cycleSize2Severity ?? 'off';

    const signals: Signal[] = [];
    for (const scc of features.scc) {
      const base = bandFor(scc, minSize, size2);
      if (base === undefined) continue;
      const anchor = anchorOccurrence(scc, indexes);
      /* v8 ignore next */
      if (!anchor) continue;
      // Skip a cycle whose members are ALL in test files — a recursive test
      // helper or mutually-recursive fixtures are test code, not a production
      // architecture concern (consistent with the test-file skip in the other
      // graph rules). A cycle that includes ANY production member is kept.
      if (isTestOnlyScc(scc, indexes)) continue;
      // The distinct packages this SCC spans — the cross-link to
      // graph:unexpected-coupling's per-package-pair-cycle signal. Only
      // meaningful (more than one package) when the SCC crosses packages.
      const spannedPackages = scc.crossesPackages ? packagesOf(scc, indexes) : undefined;
      signals.push(
        createGraphSignal('graph:cycle', config, {
          severity: base,
          category: 'architecture',
          message: `${anchor.simpleName} is part of a ${String(scc.sccSize)}-function call cycle${scc.crossesPackages ? ' spanning multiple packages' : ''}.`,
          code: { file: anchor.filePath, line: anchor.line, column: anchor.column },
          suggestion: 'Break the cycle: invert one dependency or extract the shared piece.',
          metadata: {
            sccId: scc.id,
            sccSize: scc.sccSize,
            crossesPackages: scc.crossesPackages,
            qualifiedName: anchor.qualifiedName,
            // Cross-link to graph:unexpected-coupling's per-package-pair-cycle
            // signal: the distinct packages this cross-package SCC spans
            // (undefined for an intra-package cycle).
            relatedPackageCycle: spannedPackages,
            // Every member's source location (ADR-0014): a `@graph-ignore`
            // directive above ANY member waives this one-per-SCC finding, not
            // only the computed anchor line. Metadata is not fingerprinted, so
            // this is baseline-neutral.
            memberLocations: memberLocations(scc, indexes),
          },
        }),
      );
    }
    return signals;
  },
});

/**
 * Resolve the SCC's severity band, or `undefined` for "no signal".
 *  - size 1 → no signal;
 *  - crossesPackages → `high` (wins regardless of size);
 *  - size 2 → the configured size-2 posture (`off` → none, `low` → `low`);
 *  - size ≥ minSize → `medium`;
 *  - otherwise (e.g. a size-2 with size2 off, or a sub-minSize size ≥ 3 when
 *    minSize was raised) → no signal.
 */
function bandFor(
  scc: SccFeatures,
  minSize: number,
  size2: 'off' | 'low',
): SignalSeverity | undefined {
  if (scc.sccSize <= 1) return undefined;
  if (scc.crossesPackages) return 'high';
  if (scc.sccSize === 2) return size2 === 'low' ? 'low' : undefined;
  if (scc.sccSize >= minSize) return 'medium';
  return undefined;
}

/**
 * The lowest-`qualifiedName` member occurrence of the SCC — the stable anchor
 * for the one-per-SCC signal (mirrors duplicated-function-body's
 * `lowestByQualifiedName`). Members are occIds
 * (`${filePath}:${line}:${column}`); resolve each via `byOccId`.
 */
function anchorOccurrence(scc: SccFeatures, indexes: Indexes): FunctionOccurrence | undefined {
  let anchor: FunctionOccurrence | undefined;
  for (const id of scc.members) {
    const occ = indexes.byOccId.get(id);
    if (!occ) continue;
    if (!anchor || occ.qualifiedName < anchor.qualifiedName) anchor = occ;
  }
  return anchor;
}

/**
 * True when EVERY resolvable member of the SCC lives in a test file (a cycle
 * entirely within test code). Returns false the moment any member is a
 * production occurrence, so a cycle that touches production is still reported.
 */
function isTestOnlyScc(scc: SccFeatures, indexes: Indexes): boolean {
  let sawMember = false;
  for (const id of scc.members) {
    const occ = indexes.byOccId.get(id);
    if (!occ) continue;
    sawMember = true;
    if (!occ.inTestFile) return false;
  }
  return sawMember;
}

/** The sorted distinct packages an SCC's resolvable members belong to. */
function packagesOf(scc: SccFeatures, indexes: Indexes): readonly string[] {
  const packages = new Set<string>();
  for (const id of scc.members) {
    const occ = indexes.byOccId.get(id);
    if (occ) packages.add(pkgOf(occ));
  }
  return [...packages].sort();
}

/**
 * Every resolvable member's `{ file, line }` — the candidate locations a
 * `@graph-ignore` directive may target to waive this SCC (ADR-0014). Consumed
 * by graph's suppression `locate()` so a directive above any member matches.
 */
function memberLocations(
  scc: SccFeatures,
  indexes: Indexes,
): readonly { readonly file: string; readonly line: number }[] {
  const locations: { file: string; line: number }[] = [];
  for (const id of scc.members) {
    const occ = indexes.byOccId.get(id);
    if (occ?.filePath) locations.push({ file: occ.filePath, line: occ.line });
  }
  return locations;
}
