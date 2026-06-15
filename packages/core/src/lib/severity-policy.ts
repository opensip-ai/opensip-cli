/**
 * SeverityPolicy — the one home for severity mapping + the gate's error/warning
 * predicate (north-star §5.9, launch).
 *
 * Severity lives at two levels: AUTHOR severity (`error | warning`, what a fitness
 * check or graph rule declares) and WIRE severity (the 4-level
 * {@link SignalSeverity} on the `Signal`). Previously the author→wire map was
 * duplicated (fitness's `mapFindingSeverity` + `liftSeverity`) and the graph
 * override (`applySeverityOverride`) lived apart, while the gate's error/warning
 * counting was inlined in `buildSignalEnvelope`. This consolidates them so a
 * change to severity semantics is one edit and every consumer agrees.
 *
 * The mappings are byte-identical to what they replace: `error → high`,
 * `warning → medium` (UP, never collapsing, so the error-rung / warning-rung
 * bucketing reproduces the historical counts), and the override clamps only when
 * explicitly set (ADR-0005 / baseline-neutral).
 */

import { isErrorSeverity, type SignalSeverity } from '../types/signal.js';

/** The 2-level severity a check/rule author declares (mapped UP to the wire level). */
export type AuthorSeverity = 'error' | 'warning';

/**
 * The central severity policy. A frozen namespace (not per-run state) — pure
 * functions over the severity types, the single source of truth for author→wire
 * mapping, the override clamp, and the error/warning predicate.
 */
export const SeverityPolicy = Object.freeze({
  /** Author `error|warning` → wire severity: `error → high`, `warning → medium`. */
  liftAuthorSeverity(severity: AuthorSeverity): SignalSeverity {
    return severity === 'error' ? 'high' : 'medium';
  },

  /**
   * Clamp a base wire severity by an opt-in override (`error → high`,
   * `warning → medium`); returns `base` unchanged when no override is set
   * (baseline-neutral, ADR-0005).
   */
  applyOverride(base: SignalSeverity, override: AuthorSeverity | undefined): SignalSeverity {
    if (override === undefined) return base;
    return override === 'error' ? 'high' : 'medium';
  },

  /** True when a severity is on the error rung (`critical`/`high`) — the gate predicate. */
  isError(severity: SignalSeverity): boolean {
    return isErrorSeverity(severity);
  },
} as const);
