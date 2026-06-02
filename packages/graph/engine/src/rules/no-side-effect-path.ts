/**
 * graph:no-side-effect-path — flag functions that are pure-by-design
 * AND whose return value is discarded by at least one caller, i.e.
 * functions whose computation has no observable effect on the program.
 *
 * Heuristic, in order:
 *   1. The function's entire transitive callee set is side-effect free
 *      (no I/O, logging, mutation, or unresolved edges).
 *   2. At least one inbound caller invokes this function as an
 *      ExpressionStatement (its return value is discarded).
 *
 * Step 2 is what makes the signal actionable. A pure function that
 * returns data is a feature when its return value is consumed
 * (`const x = pureHelper(...)`); it is dead code when the value is
 * thrown away (`pureHelper(...);` as a standalone statement).
 *
 * Catalogs from older runs that lack the `discarded` field on call
 * edges fall back to the legacy "any pure callee" check.
 *
 * Side-effect primitives are language-specific. The active adapter
 * supplies `ruleHints.sideEffectPrimitives` (e.g. `print`, `os.system`
 * for Python; `println!`, `panic!` for Rust). When the hint is
 * absent — older adapters, third-party adapters that don't populate
 * it, unit tests that don't pass hints — we fall back to a
 * TypeScript-shaped textual regex so the rule never silently goes
 * dark on a TS project. The fidelity matrix in the graph
 * rules-and-gating documentation enumerates which rules degrade
 * gracefully when an adapter omits a given hint.
 */

import { createSignal } from '@opensip-tools/core';

import { defineRule } from './define-rule.js';

import type { FunctionOccurrence, Indexes, RuleHints } from '../types.js';
import type { Signal } from '@opensip-tools/core';

const TYPESCRIPT_FALLBACK_REGEX =
  /\b(?:console|logger|fs\.|http\.|fetch|process\.exit|throw\s+new)\b/;

/**
 * Detector for "the call text contains a side-effect primitive."
 * Built once per rule invocation: when the adapter supplies
 * `sideEffectPrimitives`, we precompile a Set<string> for substring
 * matching at the start of the call text (after stripping common
 * prefixes); otherwise we fall back to the legacy TS-shaped regex.
 */
type SideEffectDetector = (callText: string) => boolean;

function buildSideEffectDetector(hints: RuleHints | undefined): SideEffectDetector {
  const primitives = hints?.sideEffectPrimitives;
  if (!primitives || primitives.length === 0) {
    return (text) => TYPESCRIPT_FALLBACK_REGEX.test(text);
  }
  // Adapter-supplied primitives are textual prefixes a developer would
  // write at the start of a call expression: "print", "os.system",
  // "console.log", "println!". Match by substring presence — call text
  // is already truncated to ≤80 chars by the inventory pipeline, so
  // searching every primitive across every call text is O(P · 80) per
  // call, cheap.
  const primitiveSet = [...primitives];
  return (text) => {
    for (const p of primitiveSet) {
      if (p.length === 0) continue;
      if (text.includes(p)) return true;
    }
    return false;
  };
}

export const noSideEffectPathRule = defineRule({
  slug: 'graph:no-side-effect-path',
  defaultSeverity: 'warning',
  evaluate({ indexes, hints }): readonly Signal[] {
    const detector = buildSideEffectDetector(hints);
    const sideEffecting = computeSideEffecting(indexes, detector);
    const signals: Signal[] = [];
    for (const occ of indexes.byBodyHash.values()) {
      if (!isPureCandidate(occ, sideEffecting)) continue;
      const reachable = transitiveCallees(occ, indexes);
      const anyEffecting = [...reachable].some((h) => sideEffecting.has(h));
      if (anyEffecting) continue;
      if (!hasDiscardedCaller(occ, indexes)) continue;
      signals.push(
        createSignal({
          source: 'graph',
          severity: 'low',
          category: 'quality',
          ruleId: 'graph:no-side-effect-path',
          message: `${occ.simpleName} is pure but at least one caller discards its return value, so the call has no observable effect.`,
          code: { file: occ.filePath, line: occ.line, column: occ.column },
          suggestion: 'Either consume the return value at the call site, or remove the call.',
          metadata: {
            qualifiedName: occ.qualifiedName,
            transitiveCount: reachable.size,
          },
        }),
      );
    }
    return signals;
  },
});

/**
 * True when at least one caller invokes this function as an
 * ExpressionStatement (return value discarded). Catalogs that
 * predate the `discarded` field surface every edge as undefined,
 * which we treat as "unknown" — fall back to the prior behavior
 * (always pass) so older catalogs aren't silently filtered out.
 */
interface CallerScanResult {
  readonly foundDiscarded: boolean;
  readonly sawMatchingEdge: boolean;
  readonly sawDiscardedField: boolean;
}

function scanCallerEdges(occ: FunctionOccurrence, indexes: Indexes): CallerScanResult {
  const callerHashes = indexes.callers.get(occ.bodyHash) ?? [];
  let sawMatchingEdge = false;
  let sawDiscardedField = false;
  for (const callerHash of callerHashes) {
    const caller = indexes.byBodyHash.get(callerHash);
    /* v8 ignore next */
    if (!caller) continue;
    for (const edge of caller.calls) {
      if (!edge.to.includes(occ.bodyHash)) continue;
      sawMatchingEdge = true;
      if (edge.discarded === undefined) continue;
      sawDiscardedField = true;
      if (edge.discarded) return { foundDiscarded: true, sawMatchingEdge, sawDiscardedField };
    }
  }
  return { foundDiscarded: false, sawMatchingEdge, sawDiscardedField };
}

function hasDiscardedCaller(occ: FunctionOccurrence, indexes: Indexes): boolean {
  const scan = scanCallerEdges(occ, indexes);
  if (scan.foundDiscarded) return true;
  // Legacy fallback (`!sawDiscardedField`) only applies when we
  // actually observed an edge that targets this occurrence — otherwise
  // the index pointed at this occ but no caller edge resolved to it
  // (stale index / unresolved catalog), and the right answer is "no
  // discarded caller" not "assume yes".
  return scan.sawMatchingEdge && !scan.sawDiscardedField;
}

/**
 * Declared return types that mean "this function yields no value." A
 * void-like return type covers every language the graph tool ingests:
 * `void`/`undefined`/`never` (TS), `Promise<void>` (async TS that
 * resolves nothing), `()` (Rust unit), `None` (Python).
 *
 * Matched case-insensitively after trimming.
 */
const VOID_LIKE_RETURN_TYPES: ReadonlySet<string> = new Set([
  'void',
  'undefined',
  'never',
  'promise<void>',
  '()',
  'none',
]);

/**
 * True when the function's DECLARED return type proves it has no return
 * value to discard.
 *
 * The rule's whole actionable premise is "a caller is throwing away a
 * return value, so the call is dead computation." For a function declared
 * `: void` (or any void-like type) there is no value to throw away — the
 * function exists for its effect, not its result. The textual purity
 * heuristic (`textualSideEffect`) cannot see effects like closure-binding
 * reassignment, throw-delegation, or out-parameter mutation, so such
 * effect-only functions look "pure" and get flagged falsely. Rejecting
 * void-like return types makes the premise non-vacuous.
 *
 * IMPORTANT: a `null` return type means "unknown / not annotated", NOT
 * "void". Rejecting `null` would introduce false negatives on genuinely
 * pure, un-annotated functions whose result is dropped — so `null` passes
 * through. Only the explicit void-like strings are rejected.
 */
function returnsNoValue(returnType: string | null): boolean {
  if (returnType === null) return false;
  return VOID_LIKE_RETURN_TYPES.has(returnType.trim().toLowerCase());
}

/** Filters out occurrences we never want to flag — short, test-only, has unresolved edges, etc. */
function isPureCandidate(occ: FunctionOccurrence, sideEffecting: ReadonlySet<string>): boolean {
  if (occ.kind === 'module-init') return false;
  if (occ.inTestFile) return false;
  if (occ.calls.length < 2) return false;
  const span = occ.endLine - occ.line + 1;
  if (span < 10) return false;
  if (occ.calls.some((e) => e.to.length === 0)) return false;
  if (sideEffecting.has(occ.bodyHash)) return false;
  if (occ.visibility !== 'exported') return false;
  // Effect-only functions (void-like return type) have no return value to
  // discard, so the "discarded return value" signal is vacuous for them.
  if (returnsNoValue(occ.returnType)) return false;
  return true;
}

function computeSideEffecting(
  indexes: Indexes,
  detector: SideEffectDetector,
): Set<string> {
  const set = new Set<string>();
  for (const occ of indexes.byBodyHash.values()) {
    if (textualSideEffect(occ, detector)) set.add(occ.bodyHash);
  }
  return set;
}

function textualSideEffect(
  occ: FunctionOccurrence,
  detector: SideEffectDetector,
): boolean {
  for (const edge of occ.calls) {
    if (detector(edge.text)) return true;
  }
  return false;
}

function transitiveCallees(start: FunctionOccurrence, indexes: Indexes): ReadonlySet<string> {
  const visited = new Set<string>();
  const queue: string[] = [start.bodyHash];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (cur === undefined || visited.has(cur)) continue;
    visited.add(cur);
    const next = indexes.callees.get(cur) ?? [];
    for (const n of next) {
      if (!visited.has(n)) queue.push(n);
    }
  }
  visited.delete(start.bodyHash);
  return visited;
}
