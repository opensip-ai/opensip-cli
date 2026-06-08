/**
 * graph:high-blast-untested (flagship) — flag high-reach functions that are
 * NOT exercised by any test. The combination gate ADR-0001 sanctions: a raw
 * metric (`blast`) gates only as an **ABSOLUTE-threshold input** to a bounded,
 * actionable predicate, never as a ranking/percentile.
 *
 * Predicate (per occurrence): `blast.score >= absoluteThreshold && !testReachable`.
 *   - test-reachable → skip (a high-blast TESTED function emits nothing).
 *   - `blast.score < warn` → skip (a LOW-blast untested function emits nothing — noise).
 *   - `blast.score >= error` → base `high`; else (`[warn, error)`) → base `medium`.
 *
 * The count reaches zero once every high-blast function is test-covered →
 * bounded → gateable. The fix is one verb: add a test. Thresholds are in-rule
 * opinionated ABSOLUTE constants, overridable via `config.highBlastWarnThreshold`
 * / `highBlastErrorThreshold` (Phase A). Emitted severity routes through the
 * opt-in `applySeverityOverride` clamp (ADR-0005).
 *
 * Feature columns: `blast` (composite reach score `direct + 0.5 × transitive`)
 * and `testReachable` (the boolean companion to `reachableOnlyFromTests`).
 * Both are needed-only `featureDeps`. When the columns are absent (e.g. a
 * 3/4-arg test call with no features), the rule degrades to emitting nothing
 * (spec Applicable Conventions: absent column → emit nothing) — blast/test
 * reachability are NOT cheaply recomputable in-rule, so there is no fallback.
 */

import { createGraphSignal } from './create-graph-signal.js';
import { defineRule } from './define-rule.js';

import type { Signal } from '@opensip-tools/core';

const DEFAULT_WARN_BLAST = 75;
const DEFAULT_ERROR_BLAST = 150;

export const highBlastUntestedRule = defineRule({
  slug: 'graph:high-blast-untested',
  defaultSeverity: 'warning',
  featureDeps: ['blast', 'reachableOnlyFromTests'],
  evaluate({ indexes, config, features }): readonly Signal[] {
    // Absent feature table → emit nothing (no in-rule recompute of blast/test
    // reachability; the canonical home is pipeline/features.ts).
    if (!features) return [];
    const warn = config.highBlastWarnThreshold ?? DEFAULT_WARN_BLAST;
    const error = config.highBlastErrorThreshold ?? DEFAULT_ERROR_BLAST;

    const signals: Signal[] = [];
    for (const occ of indexes.byBodyHash.values()) {
      /* v8 ignore next */
      if (!occ.filePath) continue;
      // A function DEFINED in a test file is itself test code — asking whether
      // it "is reached by a test" is meaningless, so it must never be flagged
      // as a high-blast untested production function. Skip test-file occurrences.
      if (occ.inTestFile) continue;
      const row = features.function.get(occ.bodyHash);
      const blast = row?.blast;
      // Blast column absent for this row → can't gate → skip.
      if (!blast) continue;
      // A high-blast TESTED function is not a defect — skip. `testReachable`
      // absent ⇒ treat as not-reachable (the column was requested, so absence
      // means the row genuinely has no production/test coverage signal).
      if (row.testReachable === true) continue;
      const score = blast.score;
      if (score < warn) continue;
      const base = score >= error ? 'high' : 'medium';
      signals.push(
        createGraphSignal('graph:high-blast-untested', config, {
          severity: base,
          category: 'testing',
          message: `${occ.simpleName} has a high blast radius (score ${String(score)}) but is not reached by any test.`,
          code: { file: occ.filePath, line: occ.line, column: occ.column },
          suggestion: 'Add a test that exercises this high-reach function.',
          metadata: {
            blast: score,
            blastDirect: blast.direct,
            blastTransitive: blast.transitive,
            testReachable: false,
            qualifiedName: occ.qualifiedName,
          },
        }),
      );
    }
    return signals;
  },
});
