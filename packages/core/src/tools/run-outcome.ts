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

/** Inputs for stamping a new session row from a completed run. */
export interface DeriveRunOutcomeInput {
  readonly passed: boolean;
  /** When set, overrides the passed/failed inference (e.g. strict `degraded`). */
  readonly explicit?: ToolRunOutcome;
}

/**
 * Derive the outcome to persist for a credible-scan contribution.
 *
 * `deriveRunOutcome` only ever stamps a completed contribution's session row: an
 * explicit tool outcome (e.g. strict `degraded`) wins; otherwise the scan verdict
 * maps to `passed`/`failed`. Setup/execution faults never reach here — per ADR-0060
 * they emit a command-error outcome outside the findings envelope with no session
 * row at all, so there is no fault/phase/evidence reasoning to do.
 */
export function deriveRunOutcome(input: DeriveRunOutcomeInput): ToolRunOutcome {
  if (input.explicit !== undefined) return input.explicit;
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
