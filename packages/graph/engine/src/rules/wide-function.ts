/**
 * graph:wide-function — flag functions with too many parameters. A two-band
 * predicate over `FunctionOccurrence.params.length` (raw catalog data — no
 * feature column, hence no Plan C dependency).
 *
 * Bands (defaults from the dashboard's former Wide Functions view,
 * `view-wide.ts`: "above 5–6 worth scrutinizing"):
 *   - `params.length <= warn` → no signal.
 *   - `(warn, error]`         → base `medium`.
 *   - `> error`               → base `high`.
 *
 * Thresholds are in-rule opinionated constants, overridable via
 * `config.wideFunctionWarnParams` / `wideFunctionErrorParams` (Phase A). The
 * emitted severity routes through the opt-in `applySeverityOverride` clamp
 * (ADR-0005). Language-agnostic: every adapter emits `params`.
 */

import { createGraphSignal } from './create-graph-signal.js';
import { defineRule } from './define-rule.js';

import type { Signal } from '@opensip-tools/core';

// warn=5: `> 4 params` is a common, clean signature (e.g. a small options-ish
// positional set), so warning at 5 was noisy; warn at 6+, error at 8+ instead.
const DEFAULT_WARN_PARAMS = 5;
const DEFAULT_ERROR_PARAMS = 7;

export const wideFunctionRule = defineRule({
  slug: 'graph:wide-function',
  defaultSeverity: 'warning',
  evaluate({ indexes, config }): readonly Signal[] {
    const warn = config.wideFunctionWarnParams ?? DEFAULT_WARN_PARAMS;
    const error = config.wideFunctionErrorParams ?? DEFAULT_ERROR_PARAMS;

    const signals: Signal[] = [];
    for (const occ of indexes.byBodyHash.values()) {
      /* v8 ignore next */
      if (!occ.filePath) continue;
      // Test files are not production code subject to this quality gate (same
      // exclusion as large-function / high-blast-untested).
      if (occ.inTestFile) continue;
      const n = occ.params.length;
      if (n <= warn) continue;
      const base = n > error ? 'high' : 'medium';
      signals.push(
        createGraphSignal('graph:wide-function', config, {
          severity: base,
          category: 'quality',
          message: `${occ.simpleName} takes ${String(n)} parameters.`,
          code: { file: occ.filePath, line: occ.line, column: occ.column },
          suggestion:
            'Group related parameters into an options object or split the function.',
          metadata: {
            paramCount: n,
            params: occ.params.map((p) => p.name),
            qualifiedName: occ.qualifiedName,
          },
        }),
      );
    }
    return signals;
  },
});
