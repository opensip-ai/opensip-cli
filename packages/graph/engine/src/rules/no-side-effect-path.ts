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

import { createGraphSignal } from './create-graph-signal.js';
import { defineRule } from './define-rule.js';

import type { FeatureTable, FunctionOccurrence, Indexes, RuleHints } from '../types.js';
import type { Signal } from '@opensip-cli/core';

const TYPESCRIPT_FALLBACK_REGEX =
  /\b(?:console|logger|log|fs\.|http\.|fetch|process\.exit|throw\s+new)\b/;

/**
 * Language-agnostic structural side-effect patterns, applied to EVERY call
 * text regardless of which adapter (or fallback) supplies the primitive
 * list. These cover effect classes the narrow primitive lists miss and that
 * caused verified false positives downstream:
 *
 *   1. Mutator method calls — `.push(`, `.set(`, `.add(`, `.delete(`,
 *      `.clear(`, `.pop(`, `.shift(`, `.unshift(`, `.splice(`, `.fill(`,
 *      `.sort(`, `.reverse(`, `.copyWithin(`, `.append(`, `.write(`,
 *      `.emit(`. A call mutating a Map/Set/array/stream IS a side effect
 *      even when the array/map is module-scoped (which the call-edge model
 *      cannot otherwise see).
 *   2. Observability / telemetry / logging helper calls — names containing
 *      `record…`, `report…`, `track…`, `withSpan` / `with*Span`, `log`,
 *      `emit`, `metric`, `trace`, `span`, `instrument`, `audit`. These are
 *      effect-only helpers (they write to OTel / metrics / logs) but the
 *      transitive purity walk can't prove that when the helper is imported
 *      from another module whose body isn't in the catalog, or whose body
 *      reaches the effect through a tracer object method the primitive list
 *      doesn't enumerate. Treating the CALL SITE as effecting is the
 *      conservative answer — it can only ever SUPPRESS a flag, never add a
 *      false one.
 *
 * Conservative by construction: a match removes a candidate from the flag
 * set, so the worst case is a missed true positive (false negative), never
 * a new false positive — exactly the direction this rule must err.
 */
// Split into four independent patterns (mutator method call / telemetry helper
// call / span wrapper / bare telemetry word), OR-composed in
// {@link hasStructuralSideEffect}. This is behaviorally identical to the former
// single alternation but keeps each pattern under the regex-complexity bound.
const SE_MUTATOR_REGEX =
  /\.(?:push|pop|shift|unshift|splice|fill|sort|reverse|copyWithin|set|add|delete|clear|append|write|emit)\s*\(/;
const SE_TELEMETRY_REGEX = /\b(?:record|report|track|emit|instrument|audit)[A-Z][A-Za-z0-9]*\s*\(/;
const SE_SPAN_REGEX = /\bwith[A-Za-z0-9]*[Ss]pan\s*\(/;
const SE_BAREWORD_REGEX = /\b(?:logger|log|metric|metrics|tracer|trace|span)\b/;

/** True when the call text contains any structural side-effect primitive. */
function hasStructuralSideEffect(text: string): boolean {
  return (
    SE_MUTATOR_REGEX.test(text) ||
    SE_TELEMETRY_REGEX.test(text) ||
    SE_SPAN_REGEX.test(text) ||
    SE_BAREWORD_REGEX.test(text)
  );
}

/**
 * Detector for "the call text contains a side-effect primitive."
 * Built once per rule invocation: when the adapter supplies
 * `sideEffectPrimitives`, we precompile a Set<string> for substring
 * matching at the start of the call text (after stripping common
 * prefixes); otherwise we fall back to the legacy TS-shaped regex.
 *
 * Either layer is composed with the language-agnostic
 * {@link hasStructuralSideEffect} (mutators + telemetry/logging helper
 * conventions) so the rule never classifies a mutating or
 * observability-emitting function as pure regardless of adapter.
 */
type SideEffectDetector = (callText: string) => boolean;

function buildSideEffectDetector(hints: RuleHints | undefined): SideEffectDetector {
  const primitiveDetector = buildPrimitiveDetector(hints);
  return (text) => primitiveDetector(text) || hasStructuralSideEffect(text);
}

function buildPrimitiveDetector(hints: RuleHints | undefined): SideEffectDetector {
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
  featureDeps: ['bodyLines'],
  evaluate({ indexes, hints, features, config }): readonly Signal[] {
    const detector = buildSideEffectDetector(hints);
    const sideEffecting = computeSideEffecting(indexes, detector);
    const signals: Signal[] = [];
    for (const occ of indexes.byBodyHash.values()) {
      if (!isPureCandidate(occ, sideEffecting, features)) continue;
      const reachable = transitiveCallees(occ, indexes);
      let anyEffecting = false;
      for (const h of reachable) {
        if (sideEffecting.has(h)) {
          anyEffecting = true;
          break;
        }
      }
      if (anyEffecting) continue;
      if (!hasDiscardedCaller(occ, indexes)) continue;
      signals.push(
        createGraphSignal('graph:no-side-effect-path', config, {
          severity: 'low',
          category: 'quality',
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
 * Aggregate of every inbound call edge that targets this occurrence.
 *
 * The actionable signal is "this function's result is dead computation" —
 * which is only true when EVERY caller throws the return value away. A
 * return value that flows into a binding (`const r = f()`), an argument, a
 * `return`, or an `arr.map(x => f(x))` mapping IS consumed (the upstream
 * resolver records those edges as `discarded: false`, since none is an
 * ExpressionStatement). A single consuming caller is enough to make the
 * call non-dead, so we must NOT flag when any resolved caller consumes.
 *
 * Catalogs that predate the `discarded` field surface every edge as
 * `undefined`, which we treat as "unknown" — fall back to the prior
 * behavior (flag) so older catalogs aren't silently filtered out.
 */
interface CallerScanResult {
  /** At least one inbound edge targets this occurrence. */
  readonly sawMatchingEdge: boolean;
  /** At least one inbound edge carried a concrete `discarded` value. */
  readonly sawDiscardedField: boolean;
  /** At least one inbound edge has `discarded === true`. */
  readonly anyDiscarded: boolean;
  /**
   * At least one inbound edge with a concrete `discarded` value has
   * `discarded === false` — i.e. a caller PROVABLY consumes the return.
   */
  readonly anyConsumed: boolean;
}

function scanCallerEdges(occ: FunctionOccurrence, indexes: Indexes): CallerScanResult {
  const callerHashes = indexes.callers.get(occ.bodyHash) ?? [];
  let sawMatchingEdge = false;
  let sawDiscardedField = false;
  let anyDiscarded = false;
  let anyConsumed = false;
  for (const callerHash of callerHashes) {
    const caller = indexes.byBodyHash.get(callerHash);
    /* v8 ignore next */
    if (!caller) continue;
    for (const edge of caller.calls) {
      if (!edge.to.includes(occ.bodyHash)) continue;
      sawMatchingEdge = true;
      if (edge.discarded === undefined) continue;
      sawDiscardedField = true;
      if (edge.discarded) anyDiscarded = true;
      else anyConsumed = true;
    }
  }
  return { sawMatchingEdge, sawDiscardedField, anyDiscarded, anyConsumed };
}

/**
 * True only when EVERY resolved caller provably discards the return value.
 *
 * Narrowed from the prior "any caller discards" to eliminate the verified
 * false positive where a value reached via `arr.map(x => f(x))` or bound
 * (`const r = f(...)`) and later used was flagged: the mapped/bound result
 * IS consumed, so a single consuming caller (`anyConsumed`) must veto the
 * signal even if another caller happens to discard.
 */
function hasDiscardedCaller(occ: FunctionOccurrence, indexes: Indexes): boolean {
  const scan = scanCallerEdges(occ, indexes);
  // A provably-consuming caller means the function's result is live — never
  // dead computation. This veto is what fixes the `.map(...)` / bound-and-
  // used false positive.
  if (scan.anyConsumed) return false;
  if (scan.anyDiscarded) return true;
  // Legacy fallback only applies when we actually observed an edge that
  // targets this occurrence but NONE carried a concrete `discarded` value
  // (a pre-discard catalog) — otherwise the index pointed at this occ but
  // no caller edge resolved to it (stale index / unresolved catalog), and
  // the right answer is "no discarded caller" not "assume yes".
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
function isPureCandidate(
  occ: FunctionOccurrence,
  sideEffecting: ReadonlySet<string>,
  features: FeatureTable | undefined,
): boolean {
  if (occ.kind === 'module-init') return false;
  if (occ.inTestFile) return false;
  if (occ.calls.length < 2) return false;
  // bodyLines feature column is the canonical span; the inline
  // `endLine − line + 1` is the single sanctioned graceful-degrade fallback
  // for features-absent calls, not a duplicate of the engine derivation.
  const span = features?.function.get(occ.bodyHash)?.bodyLines ?? occ.endLine - occ.line + 1;
  if (span < 10) return false;
  if (occ.calls.some((e) => e.to.length === 0)) return false;
  if (sideEffecting.has(occ.bodyHash)) return false;
  if (occ.visibility !== 'exported') return false;
  // Effect-only functions (void-like return type) have no return value to
  // discard, so the "discarded return value" signal is vacuous for them.
  if (returnsNoValue(occ.returnType)) return false;
  return true;
}

function computeSideEffecting(indexes: Indexes, detector: SideEffectDetector): Set<string> {
  const set = new Set<string>();
  for (const occ of indexes.byBodyHash.values()) {
    if (textualSideEffect(occ, detector)) set.add(occ.bodyHash);
  }
  return set;
}

function textualSideEffect(occ: FunctionOccurrence, detector: SideEffectDetector): boolean {
  for (const edge of occ.calls) {
    if (detector(edge.text)) return true;
  }
  return false;
}

function transitiveCallees(start: FunctionOccurrence, indexes: Indexes): ReadonlySet<string> {
  const visited = new Set<string>();
  // Iterate the growing queue directly: the Array iterator reads `length`
  // live, so nodes pushed mid-iteration are still visited in FIFO order —
  // the same traversal as Array.shift() but O(V+E) instead of O(V²) (shift()
  // is an O(n) dequeue).
  const queue: string[] = [start.bodyHash];
  for (const cur of queue) {
    if (visited.has(cur)) continue;
    visited.add(cur);
    const next = indexes.callees.get(cur) ?? [];
    for (const n of next) {
      if (!visited.has(n)) queue.push(n);
    }
  }
  visited.delete(start.bodyHash);
  return visited;
}
