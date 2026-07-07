/**
 * The 3-way run/step OUTCOME — the single source of truth for pass / fail /
 * fault across BOTH single-tool runs (`viewResultSummary`) AND suite aggregation
 * (`deriveSuiteAggregate`). Prior to this, only the suite derived a 3-way (and
 * did it from `step.error`, which is set only for run-LEVEL throws, so a
 * unit-level fault — a crashed check — was mislabeled `failed`). Deriving from
 * the `RunVerdict` (which carries the authoritative `faulted` bit computed once
 * in `buildSignalEnvelope` from `runFaulted || unitFaulted`) fixes that and
 * gives single runs a `faulted` state they never had.
 */

/**
 * A run's terminal outcome:
 * - `passed` — ran, findings within the gate.
 * - `failed` — ran, findings crossed `failOnErrors`/`failOnWarnings` (a real
 *   code problem).
 * - `faulted` — a RUNTIME error (a unit threw/timed-out, a plugin/tool died).
 *   The result is UNKNOWN — the tool couldn't be trusted to have found the real
 *   problems. Distinct from `failed`, and by default non-blocking for a suite
 *   (see `failOnFault`).
 */
export type RunOutcome = 'passed' | 'failed' | 'faulted';

/**
 * Map a verdict to its {@link RunOutcome}. A fault DOMINATES a findings result
 * (a crashed run's findings are untrustworthy), so `faulted` is checked first.
 *
 * `faulted` is optional on the verdict for forward-compat: a legacy envelope
 * (persisted before the tri-state) omits it and degrades to the binary
 * passed/failed — it simply can't distinguish a fault from a findings failure.
 */
export function deriveOutcome(verdict: {
  readonly passed: boolean;
  readonly faulted?: boolean;
}): RunOutcome {
  if (verdict.faulted === true) return 'faulted';
  return verdict.passed ? 'passed' : 'failed';
}
