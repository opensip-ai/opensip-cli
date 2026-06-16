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

import type { CallEdge, Catalog, FunctionOccurrence } from '../types.js';
import type { Signal } from '@opensip-cli/core';

const TYPESCRIPT_FALLBACK_THROW_REGEX = /^\s*throw\s+(?:new\s+)?[A-Z]\w*/;

/**
 * Prefix the adapters stamp onto a *creation* edge (`[creates] () => …`),
 * mirroring `CREATION_EDGE_PREFIX` in `lang-adapter/edge-helpers.ts`. An
 * occurrence that is the TARGET of such an edge is an inline callable
 * (arrow / function-expression) that some enclosing scope merely *creates*
 * and returns/passes — not a standalone helper the program calls for its
 * always-throwing effect. Inlined here (rather than imported) to keep this
 * rule module dependency-free of the edge-helper surface; the literal is the
 * documented producer-side contract.
 */
const CREATION_EDGE_PREFIX = '[creates] ';

/**
 * A function "appears to always throw" only when a throw is reachable in its
 * OWN control flow. A `throw` that lives inside a NESTED function expression /
 * arrow / returned closure is NOT the outer function's control flow — the outer
 * function merely RETURNS or PASSES the closure; the throw fires only when the
 * inner callable is later invoked.
 *
 * Two boundaries enforce that, both conservative (genuine always-throw helpers
 * keep firing):
 *
 *  1. **Nested-body boundary.** When an adapter attributes a throw-shaped edge
 *     to an enclosing occurrence even though the throw textually lives inside a
 *     nested function declared within that occurrence's source span, the edge is
 *     not part of the enclosing function's own control flow. We drop any edge
 *     whose source line falls inside a nested occurrence's `[line, endLine]`
 *     span before testing "every remaining edge is a throw."
 *
 *  2. **Returned-closure boundary.** The flagged occurrence is itself an inline
 *     callable that an enclosing scope created (the target of a `[creates] …`
 *     edge). A Proxy `get` trap of the form `get() { return () => { throw … } }`
 *     produces exactly this: the inner arrow's only edge is the throw, but the
 *     arrow is a lazily-throwing closure the trap returns — invoking the trap
 *     does NOT throw. We never flag an occurrence that is a created inline
 *     callable.
 */
function collectCreatedInlineCallableHashes(catalog: Catalog): ReadonlySet<string> {
  const created = new Set<string>();
  for (const occurrences of Object.values(catalog.functions)) {
    for (const occ of occurrences) {
      for (const e of occ.calls) {
        if (!e.text.startsWith(CREATION_EDGE_PREFIX)) continue;
        for (const targetHash of e.to) created.add(targetHash);
      }
    }
  }
  return created;
}

/**
 * Nested occurrences declared *inside* `outer`'s source span (same file,
 * strictly contained `[line, endLine]`, not `outer` itself). A throw edge whose
 * source line falls within one of these spans belongs to the nested function's
 * control flow, not `outer`'s.
 */
function nestedSpansWithin(
  outer: FunctionOccurrence,
  catalog: Catalog,
): readonly { readonly line: number; readonly endLine: number }[] {
  const spans: { line: number; endLine: number }[] = [];
  for (const occurrences of Object.values(catalog.functions)) {
    for (const occ of occurrences) {
      if (occ.filePath !== outer.filePath) continue;
      if (occ.bodyHash === outer.bodyHash && occ.line === outer.line && occ.column === outer.column)
        continue;
      // Strictly contained within the outer's declaration span.
      if (occ.line >= outer.line && occ.endLine <= outer.endLine && occ.line > outer.line) {
        spans.push({ line: occ.line, endLine: occ.endLine });
      }
    }
  }
  return spans;
}

/** True when `edge`'s source line falls inside any nested-function span. */
function edgeIsInsideNestedFunction(
  edge: CallEdge,
  nestedSpans: readonly { readonly line: number; readonly endLine: number }[],
): boolean {
  return nestedSpans.some((s) => edge.line >= s.line && edge.line <= s.endLine);
}

export const alwaysThrowsBranchRule = defineRule({
  slug: 'graph:always-throws-branch',
  defaultSeverity: 'warning',
  evaluate({ catalog, indexes, hints, config }): readonly Signal[] {
    const throwRegex = hints?.throwSyntaxRegex ?? TYPESCRIPT_FALLBACK_THROW_REGEX;
    const createdInlineCallables = collectCreatedInlineCallableHashes(catalog);
    const signals: Signal[] = [];
    for (const occ of indexes.byBodyHash.values()) {
      if (occ.kind === 'module-init') continue;
      // An always-throwing arrow in a test file is an intentional
      // `expect(...).toThrow()` fixture (`() => { throw boom }`), not a
      // production control-flow smell. This rule targets production code,
      // so skip test-file occurrences — same guard the no-side-effect-path
      // rule applies.
      if (occ.inTestFile) continue;
      // Returned-closure boundary: this occurrence is an inline callable that
      // an enclosing scope created and returns/passes. A throw in its body
      // fires only when the closure is later invoked — it is NOT the creating
      // function's control flow (the Proxy-`get`-trap false positive).
      if (createdInlineCallables.has(occ.bodyHash)) continue;
      if (occ.calls.length === 0) continue;
      // Nested-body boundary: drop edges that textually live inside a nested
      // function declared within this occurrence's span — they are the nested
      // function's control flow, not this one's.
      const nestedSpans = nestedSpansWithin(occ, catalog);
      const ownControlFlowEdges =
        nestedSpans.length === 0
          ? occ.calls
          : occ.calls.filter((e) => !edgeIsInsideNestedFunction(e, nestedSpans));
      // If every throw-shaped edge was inside a nested function, this
      // function has no own-control-flow throw — do not flag.
      if (ownControlFlowEdges.length === 0) continue;
      // All remaining (own-control-flow) edges look like throw shapes — every
      // documented call site is a throw / raise / panic per the adapter's regex.
      const everyCallIsThrow = ownControlFlowEdges.every((e) => throwRegex.test(e.text));
      if (!everyCallIsThrow) continue;
      signals.push(
        createGraphSignal('graph:always-throws-branch', config, {
          severity: 'low',
          category: 'quality',
          message: `${occ.simpleName} appears to always throw.`,
          code: { file: occ.filePath, line: occ.line, column: occ.column },
          suggestion:
            'Inline the throw at every caller, or document the precondition this function enforces.',
          metadata: {
            qualifiedName: occ.qualifiedName,
            edgeCount: ownControlFlowEdges.length,
          },
        }),
      );
    }
    return signals;
  },
});
