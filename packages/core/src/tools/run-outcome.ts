/**
 * Persisted run outcome vocabulary (ADR-0060, Plan 00 Phase 3).
 *
 * Distinguishes credible scan outcomes (`passed` / `failed` / `degraded`) from
 * setup failures (`error`) so dashboards and session replay do not treat incomplete
 * runs as green score-100 passes.
 *
 * Execution-failure severity and SignalSeverity never alone decide this value.
 */

/** Canonical persisted run outcome for a tool session row. */
export type ToolRunOutcome = 'passed' | 'failed' | 'degraded' | 'error';

/** Lifecycle phase for contextual runOutcome projection (Plan 00). */
export type RunLifecyclePhase = 'setup' | 'execution' | 'persistence' | 'delivery' | 'shutdown';

/** Inputs for stamping a new session row from a completed run. */
export interface DeriveRunOutcomeInput {
  readonly passed: boolean;
  /** When set, overrides the passed/failed inference (e.g. strict degraded). */
  readonly explicit?: ToolRunOutcome;
  /** Host lifecycle phase when the failure/outcome was observed. */
  readonly phase?: RunLifecyclePhase;
  /** True when credible analysis evidence exists for this run. */
  readonly hasCredibleEvidence?: boolean;
  /** True when a normalized execution failure occurred. */
  readonly executionFaulted?: boolean;
}

/**
 * Derive the outcome to persist.
 *
 * Precedence (Plan 00):
 * 1. Explicit valid tool outcome wins for a completed contribution.
 * 2. Setup/execution faults without credible evidence → `error`.
 * 3. Credible analysis pass/fail/degraded remains the scan verdict.
 * 4. Post-scan delivery failure does not rewrite a credible scan verdict
 *    (caller should omit executionFaulted or pass explicit scan outcome).
 */
export function deriveRunOutcome(input: DeriveRunOutcomeInput): ToolRunOutcome {
  if (input.explicit !== undefined) return input.explicit;

  const phase = input.phase ?? 'execution';
  const credible = input.hasCredibleEvidence === true;
  const faulted = input.executionFaulted === true;

  if (faulted && !credible && (phase === 'setup' || phase === 'execution')) {
    return 'error';
  }
  if (faulted && phase === 'delivery' && credible) {
    // Delivery fault: keep scan verdict from passed flag
    return input.passed ? 'passed' : 'failed';
  }
  if (faulted && !credible) {
    return 'error';
  }
  return input.passed ? 'passed' : 'failed';
}

/** Legacy sessions without `runOutcome`: infer passed/failed only — never degraded/error. */
export function inferStoredRunOutcome(session: {
  readonly passed: boolean;
  readonly runOutcome?: ToolRunOutcome;
}): ToolRunOutcome {
  if (session.runOutcome !== undefined) return session.runOutcome;
  return session.passed ? 'passed' : 'failed';
}
