/**
 * graph:large-function — flag functions whose body is large enough to be
 * worth splitting. A two-band predicate over the `bodyLines` feature column
 * (Phase C: `endLine − line + 1`).
 *
 * Bands (`bodyLines` is the PHYSICAL span `endLine − line + 1`, so it counts
 * comments + blank lines). The gate defaults are calibrated higher than the
 * dashboard's "~80 worth questioning / ~150 too much" heuristic so the gate
 * flags genuinely oversized functions rather than every long-but-fine one
 * (on a real codebase ~80/~150 floods the baseline). Override per-project via
 * config:
 *   - `bodyLines <= warn`  → no signal.
 *   - `(warn, error]`      → base `medium`.
 *   - `> error`            → base `high`.
 *
 * Thresholds are in-rule opinionated constants, overridable via
 * `config.largeFunctionWarnLines` / `largeFunctionErrorLines` (Phase A). The
 * emitted severity routes through the opt-in `applySeverityOverride` clamp
 * (ADR-0005). Language-agnostic: every adapter emits `endLine`.
 */

import { createSignal } from '@opensip-tools/core';

import { applySeverityOverride } from './_severity-override.js';
import { defineRule } from './define-rule.js';

import type { FeatureTable, FunctionOccurrence } from '../types.js';
import type { Signal } from '@opensip-tools/core';

const DEFAULT_WARN_LINES = 300;
const DEFAULT_ERROR_LINES = 500;

export const largeFunctionRule = defineRule({
  slug: 'graph:large-function',
  defaultSeverity: 'warning',
  featureDeps: ['bodyLines'],
  evaluate({ indexes, config, features }): readonly Signal[] {
    const warn = config.largeFunctionWarnLines ?? DEFAULT_WARN_LINES;
    const error = config.largeFunctionErrorLines ?? DEFAULT_ERROR_LINES;

    const signals: Signal[] = [];
    for (const occ of indexes.byBodyHash.values()) {
      // Skip occurrences with empty filePath (defensive, as orphan-subtree does).
      /* v8 ignore next */
      if (!occ.filePath) continue;
      // The synthetic `<module-init>` occurrence is the file's whole top-level
      // body, not a function — flagging it turns this into a "file too long"
      // check (a signal that already lives in the fitness file-length check),
      // and test files are not production functions to split. Skip both so this
      // rule flags actual long FUNCTIONS in production code.
      if (occ.kind === 'module-init' || occ.inTestFile) continue;
      const bodyLines = resolveBodyLines(occ, features);
      if (bodyLines <= warn) continue;
      const base = bodyLines > error ? 'high' : 'medium';
      signals.push(
        createSignal({
          source: 'graph',
          severity: applySeverityOverride(base, 'graph:large-function', config),
          category: 'quality',
          ruleId: 'graph:large-function',
          message: `${occ.simpleName} is ${String(bodyLines)} lines long.`,
          code: { file: occ.filePath, line: occ.line, column: occ.column },
          suggestion: 'Split this function into smaller units.',
          metadata: {
            bodyLines,
            qualifiedName: occ.qualifiedName,
          },
        }),
      );
    }
    return signals;
  },
});

/**
 * Body length from the `bodyLines` feature column when present; otherwise the
 * inline `endLine − line + 1` span (the single sanctioned graceful-degrade
 * fallback — same formula the engine's feature derivation uses).
 */
function resolveBodyLines(occ: FunctionOccurrence, features: FeatureTable | undefined): number {
  return features?.function.get(occ.bodyHash)?.bodyLines ?? occ.endLine - occ.line + 1;
}
