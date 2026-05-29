/**
 * graph:high-blast-function — surface functions whose change-impact
 * (a.k.a. "blast radius") sits at the top of the codebase, as an
 * **informational structural insight**, not a defect.
 *
 * High blast is often intentional: shared kernel primitives
 * (`currentScope`, `getById`, `ConfigurationError`) and framework
 * factories (`defineCheck`) have wide reach by design — that's their
 * contract. Refactoring them to lower their score would just promote
 * the next-highest function into the top percentile; there is no
 * "clean" state for a percentile-based rule.
 *
 * The signal is therefore emitted at `'low'` severity (SARIF `note`).
 * It maps to `warning` in the CliOutput severity vocabulary because
 * the type system bottoms out there, but it should not be treated as
 * a gate. Use it as a map of where refactor risk lives — verify the
 * listed functions have stable contracts and integration coverage.
 *
 * The blast score (`BlastScore.score = direct + 0.5 × transitive`) is
 * computed in Stage 3 via bounded reverse BFS and lives in
 * `indexes.blastRadius`; this rule only decides which scores are worth
 * surfacing.
 */

import { createSignal } from '@opensip-tools/core';

import type { Rule } from '../types.js';
import type { Signal } from '@opensip-tools/core';

/** Surface the top 5% of scored functions (above the absolute floor) as informational signals. */
const SURFACE_PERCENTILE = 0.05;
/** Never surface scores below this — shallow graphs would otherwise emit noise. */
const ABSOLUTE_FLOOR = 5;

export const highBlastFunctionRule: Rule = {
  slug: 'graph:high-blast-function',
  defaultSeverity: 'warning',
  evaluate(_catalog, indexes, _config): readonly Signal[] {
    const allScores = [...indexes.blastRadius.values()].sort(
      (a, b) => b.score - a.score,
    );
    if (allScores.length === 0) return [];
    const cutoffScore = allScores[Math.floor(allScores.length * SURFACE_PERCENTILE)]?.score
      ?? Number.POSITIVE_INFINITY;
    const signals: Signal[] = [];
    for (const occ of indexes.byBodyHash.values()) {
      if (occ.kind === 'module-init') continue;
      if (occ.inTestFile) continue;
      if (occ.definedInGenerated) continue;
      const score = indexes.blastRadius.get(occ.bodyHash);
      if (!score) continue;
      if (score.score < ABSOLUTE_FLOOR) continue;
      if (score.score < cutoffScore) continue;
      signals.push(
        createSignal({
          source: 'graph',
          provider: 'opensip-tools',
          severity: 'low',
          category: 'quality',
          ruleId: 'graph:high-blast-function',
          message:
            `${occ.simpleName} has a blast radius of ${score.score.toFixed(1)} `
            + `(direct=${String(score.direct)}, transitive=${String(score.transitive)}). `
            + `Structural insight — many call sites depend on this function.`,
          code: { file: occ.filePath, line: occ.line, column: occ.column },
          suggestion:
            'Informational. High blast is often intentional (shared primitives, framework factories). '
            + 'Verify the function has a stable contract and integration coverage. '
            + 'Splitting only helps if the function genuinely does too much.',
          metadata: {
            simpleName: occ.simpleName,
            qualifiedName: occ.qualifiedName,
            kind: occ.kind,
            bodyHash: occ.bodyHash,
            blastDirect: score.direct,
            blastTransitive: score.transitive,
            blastScore: score.score,
          },
        }),
      );
    }
    return signals;
  },
};
