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
 * Throw-statement syntax is language-specific. The active adapter
 * supplies `ruleHints.throwSyntaxRegex`: TypeScript matches
 * `throw new Error(...)`; Python matches `raise SomeError(...)`;
 * Rust matches `panic!(...)`. When the hint is absent — older
 * adapters, third-party adapters that don't populate it, unit tests
 * that don't pass hints — we fall back to the TypeScript-shaped
 * regex so the rule keeps firing on the language it was originally
 * authored for. The fidelity matrix in the graph rules-and-gating
 * documentation enumerates which rules degrade gracefully when an
 * adapter omits a given hint.
 *
 * Rules that need full CFG (per-branch reachability) are deferred to
 * v0.3.
 */

import { createGraphSignal } from './create-graph-signal.js';
import { defineRule } from './define-rule.js';

import type { Signal } from '@opensip-tools/core';

const TYPESCRIPT_FALLBACK_THROW_REGEX = /^\s*throw\s+(?:new\s+)?[A-Z]\w*/;

export const alwaysThrowsBranchRule = defineRule({
  slug: 'graph:always-throws-branch',
  defaultSeverity: 'warning',
  evaluate({ indexes, hints, config }): readonly Signal[] {
    const throwRegex = hints?.throwSyntaxRegex ?? TYPESCRIPT_FALLBACK_THROW_REGEX;
    const signals: Signal[] = [];
    for (const occ of indexes.byBodyHash.values()) {
      if (occ.kind === 'module-init') continue;
      // An always-throwing arrow in a test file is an intentional
      // `expect(...).toThrow()` fixture (`() => { throw boom }`), not a
      // production control-flow smell. This rule targets production code,
      // so skip test-file occurrences — same guard the no-side-effect-path
      // rule applies.
      if (occ.inTestFile) continue;
      if (occ.calls.length === 0) continue;
      // All edges look like throw shapes — every documented call site
      // is a throw / raise / panic per the adapter's regex.
      const everyCallIsThrow = occ.calls.every((e) => throwRegex.test(e.text));
      if (!everyCallIsThrow) continue;
      signals.push(
        createGraphSignal('graph:always-throws-branch', config, {
          severity: 'low',
          category: 'quality',
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
});
