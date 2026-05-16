/**
 * graph:always-throws-branch — heuristic CFG analysis to flag
 * functions whose body is dominated by throw statements.
 *
 * v0.2 ships a textual heuristic against the catalog's per-call text
 * + the function's overall outbound edge set: a function whose only
 * calls are `throw new <Error>()` style expressions (resolution
 * 'unknown' but text matches `throw new`) is likely an
 * always-throws helper masquerading as a real function.
 *
 * Rules that need full CFG (per-branch reachability) are deferred to
 * v0.3.
 */

import { createSignal } from '@opensip-tools/core';

import type { Rule } from '../types.js';
import type { Signal } from '@opensip-tools/core';

const THROW_PATTERN = /^\s*throw\s+(?:new\s+)?[A-Z]\w*/;

export const alwaysThrowsBranchRule: Rule = {
  slug: 'graph:always-throws-branch',
  defaultSeverity: 'warning',
  evaluate(_catalog, indexes, _config): readonly Signal[] {
    const signals: Signal[] = [];
    for (const occ of indexes.byBodyHash.values()) {
      if (occ.kind === 'module-init') continue;
      if (occ.calls.length === 0) continue;
      // All edges look like `throw new ...` shapes — every documented
      // call site is a throw.
      const everyCallIsThrow = occ.calls.every((e) => THROW_PATTERN.test(e.text));
      if (!everyCallIsThrow) continue;
      signals.push(
        createSignal({
          source: 'graph',
          severity: 'low',
          category: 'quality',
          ruleId: 'graph:always-throws-branch',
          message: `${occ.simpleName} appears to always throw.`,
          code: { file: occ.filePath, line: occ.line, column: occ.column },
          suggestion: 'Inline the throw at every caller, or document the precondition this function enforces.',
          metadata: {
            qualifiedName: occ.qualifiedName,
            edgeCount: occ.calls.length,
          },
        }),
      );
    }
    return signals;
  },
};
