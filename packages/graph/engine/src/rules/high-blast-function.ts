/**
 * graph:high-blast-function — flag functions whose change-impact (a.k.a.
 * "blast radius") exceeds a threshold. A function-level analogue of
 * codeindex's file-level blast metric, computed in Stage 3 via bounded
 * reverse BFS and surfaced as a refactor-risk signal.
 *
 * The blast score (BlastScore.score = direct + 0.5 × transitive) is
 * already in `indexes.blastRadius`; this rule only decides *which*
 * scores are worth flagging and at what severity.
 */

import { createSignal } from '@opensip-tools/core';

import type { BlastScore, Rule } from '../types.js';
import type { Signal } from '@opensip-tools/core';

/**
 * Verdict returned by the threshold policy. `null` means "don't flag."
 * A non-null verdict drives the Signal severity. We intentionally
 * support both 'medium' and 'high' so the policy can escalate the
 * worst offenders without flooding the report at uniform severity.
 */
type HighBlastVerdict = 'medium' | 'high' | null;

/** Hybrid policy thresholds — tune these if the rule is too quiet or too noisy. */
const HIGH_PERCENTILE = 0.01;   // top 1% of scores → 'high'
const MEDIUM_PERCENTILE = 0.05; // next 4% (down to top 5%) → 'medium'
const ABSOLUTE_FLOOR = 5;       // never flag scores below this, regardless of percentile

/**
 * Decide whether a blast score is high enough to flag, and if so, at
 * what severity. Hybrid policy — relative percentile gate AND absolute
 * floor — so small/shallow graphs don't generate flags and pathological
 * graphs don't drown the report.
 */
function classifyBlast(
  score: BlastScore,
  allScores: readonly BlastScore[],
): HighBlastVerdict {
  if (score.score < ABSOLUTE_FLOOR) return null;
  if (allScores.length === 0) return null;
  const highCut = allScores[Math.floor(allScores.length * HIGH_PERCENTILE)]?.score
    ?? Number.POSITIVE_INFINITY;
  if (score.score >= highCut) return 'high';
  const medCut = allScores[Math.floor(allScores.length * MEDIUM_PERCENTILE)]?.score
    ?? Number.POSITIVE_INFINITY;
  if (score.score >= medCut) return 'medium';
  return null;
}

export const highBlastFunctionRule: Rule = {
  slug: 'graph:high-blast-function',
  defaultSeverity: 'warning',
  evaluate(_catalog, indexes, _config): readonly Signal[] {
    const allScores = [...indexes.blastRadius.values()].sort(
      (a, b) => b.score - a.score,
    );
    const signals: Signal[] = [];
    for (const occ of indexes.byBodyHash.values()) {
      if (occ.kind === 'module-init') continue;
      if (occ.inTestFile) continue;
      if (occ.definedInGenerated) continue;
      const score = indexes.blastRadius.get(occ.bodyHash);
      if (!score) continue;
      const verdict = classifyBlast(score, allScores);
      if (verdict === null) continue;
      signals.push(
        createSignal({
          source: 'graph',
          provider: 'opensip-tools',
          severity: verdict,
          category: 'quality',
          ruleId: 'graph:high-blast-function',
          message:
            `${occ.simpleName} has a blast radius of ${score.score.toFixed(1)} `
            + `(direct=${String(score.direct)}, transitive=${String(score.transitive)}). `
            + `Changes here ripple through many call sites — refactor with care.`,
          code: { file: occ.filePath, line: occ.line, column: occ.column },
          suggestion:
            'Consider whether this function does too much. Splitting it, '
            + 'introducing a stable interface, or adding integration coverage '
            + 'will reduce refactor risk.',
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
